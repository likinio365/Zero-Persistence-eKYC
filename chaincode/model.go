package main

// KYCStatus represents a node in the state machine.
// Valid transitions:
//
//	PENDING ──► VERIFIED ──► REVOKED   (terminal)
//	PENDING ──► REJECTED ──► PENDING   (re-submit after rejection)
//	           VERIFIED  ──► PENDING   (re-submit after verification)
type KYCStatus string

const (
	StatusPending  KYCStatus = "PENDING"
	StatusVerified KYCStatus = "VERIFIED"
	StatusRevoked  KYCStatus = "REVOKED"
	StatusRejected KYCStatus = "REJECTED"
	StatusDeleted  KYCStatus = "DELETED"
)

var validTransitions = map[KYCStatus][]KYCStatus{
	StatusPending:  {StatusVerified, StatusRejected, StatusDeleted},
	StatusVerified: {StatusRevoked, StatusPending, StatusDeleted},
	StatusRejected: {StatusPending, StatusDeleted},
	StatusRevoked:  {StatusDeleted},
	// StatusDeleted is terminal — no outgoing transitions
}

// KYCRecord is the on-ledger representation of a KYC submission.
type KYCRecord struct {
	ID                    string    `json:"id"`
	DID                   string    `json:"did"`
	Status                KYCStatus `json:"status"`
	IPFSHash              string    `json:"ipfsHash"`
	CredDefID             string    `json:"credDefId"`
	CredentialExchangeID  string    `json:"credentialExchangeId"`
	RejectionReason       string    `json:"rejectionReason"`
	CreatedAt             string    `json:"createdAt"`
	UpdatedAt             string    `json:"updatedAt"`
}

func (r *KYCRecord) canTransitionTo(next KYCStatus) bool {
	for _, allowed := range validTransitions[r.Status] {
		if allowed == next {
			return true
		}
	}
	return false
}

// HistoryEntry wraps a single GetHistoryForKey result.
type HistoryEntry struct {
	TxID      string     `json:"txId"`
	Timestamp string     `json:"timestamp"`
	IsDelete  bool       `json:"isDelete"`
	Record    *KYCRecord `json:"record,omitempty"`
}
