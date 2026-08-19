package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// KYCContract is the Hyperledger Fabric chaincode implementing KYC lifecycle.
type KYCContract struct {
	contractapi.Contract
}

// SubmitKYC creates a new KYC record in PENDING state.
func (c *KYCContract) SubmitKYC(
	ctx contractapi.TransactionContextInterface,
	id, did, ipfsHash string,
) error {
	if id == "" || did == "" || ipfsHash == "" {
		return fmt.Errorf("id, did, and ipfsHash must be non-empty")
	}
	if !isValidDID(did) {
		return fmt.Errorf("invalid DID format: %q (expected did:<method>:<identifier>)", did)
	}

	existing, err := ctx.GetStub().GetState(id)
	if err != nil {
		return fmt.Errorf("failed to read state: %w", err)
	}
	if existing != nil {
		return fmt.Errorf("KYC record %q already exists", id)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record := &KYCRecord{
		ID:        id,
		DID:       did,
		Status:    StatusPending,
		IPFSHash:  ipfsHash,
		CreatedAt: now,
		UpdatedAt: now,
	}
	return putRecord(ctx, record)
}

// VerifyKYC transitions a record from PENDING → VERIFIED.
func (c *KYCContract) VerifyKYC(
	ctx contractapi.TransactionContextInterface,
	id, credDefID string,
) error {
	if credDefID == "" {
		return fmt.Errorf("credDefID must be non-empty")
	}

	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if !record.canTransitionTo(StatusVerified) {
		return fmt.Errorf("cannot transition from %q to %q", record.Status, StatusVerified)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.Status = StatusVerified
	record.CredDefID = credDefID
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// RejectKYC transitions a record from PENDING → REJECTED with an optional reason.
func (c *KYCContract) RejectKYC(
	ctx contractapi.TransactionContextInterface,
	id, reason string,
) error {
	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if !record.canTransitionTo(StatusRejected) {
		return fmt.Errorf("cannot transition from %q to %q", record.Status, StatusRejected)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.Status = StatusRejected
	record.RejectionReason = reason
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// RevokeKYC transitions a record from VERIFIED → REVOKED.
func (c *KYCContract) RevokeKYC(
	ctx contractapi.TransactionContextInterface,
	id string,
) error {
	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if !record.canTransitionTo(StatusRevoked) {
		return fmt.Errorf("cannot transition from %q to %q", record.Status, StatusRevoked)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.Status = StatusRevoked
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// ResubmitKYC transitions a record from VERIFIED or REJECTED back to PENDING with
// a new IPFS manifest CID. Used when the applicant updates their documents.
func (c *KYCContract) ResubmitKYC(
	ctx contractapi.TransactionContextInterface,
	id, newManifestCid string,
) error {
	if newManifestCid == "" {
		return fmt.Errorf("newManifestCid must be non-empty")
	}

	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if !record.canTransitionTo(StatusPending) {
		return fmt.Errorf("cannot transition from %q to %q", record.Status, StatusPending)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.Status = StatusPending
	record.IPFSHash = newManifestCid
	record.CredDefID = ""
	record.RejectionReason = ""
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// StoreCredExchangeID stores the ACA-Py credential exchange ID after VC issuance.
// Called by the backend immediately after a successful issueCredential call.
func (c *KYCContract) StoreCredExchangeID(
	ctx contractapi.TransactionContextInterface,
	id, credExchangeID string,
) error {
	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if record.Status != StatusVerified {
		return fmt.Errorf("can only store credential exchange ID on a VERIFIED record")
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.CredentialExchangeID = credExchangeID
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// EraseKYC transitions a record to DELETED and clears personal data references (GDPR Art. 17).
// The backend must unpin IPFS content and delete the Vault key before calling this.
func (c *KYCContract) EraseKYC(
	ctx contractapi.TransactionContextInterface,
	id string,
) error {
	record, err := getRecord(ctx, id)
	if err != nil {
		return err
	}
	if !record.canTransitionTo(StatusDeleted) {
		return fmt.Errorf("cannot transition from %q to %q", record.Status, StatusDeleted)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	record.Status = StatusDeleted
	record.IPFSHash = ""
	record.CredDefID = ""
	record.CredentialExchangeID = ""
	record.RejectionReason = ""
	record.UpdatedAt = now
	return putRecord(ctx, record)
}

// GetKYC returns the KYC record for the given id.
func (c *KYCContract) GetKYC(
	ctx contractapi.TransactionContextInterface,
	id string,
) (*KYCRecord, error) {
	return getRecord(ctx, id)
}

// QueryByDID returns all KYC records for a given DID using a CouchDB rich query.
func (c *KYCContract) QueryByDID(
	ctx contractapi.TransactionContextInterface,
	did string,
) ([]*KYCRecord, error) {
	// Build query via json.Marshal to avoid injection through DID values.
	queryBytes, err := json.Marshal(map[string]interface{}{
		"selector": map[string]string{"did": did},
	})
	if err != nil {
		return nil, err
	}

	iterator, err := ctx.GetStub().GetQueryResult(string(queryBytes))
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	records := make([]*KYCRecord, 0)
	for iterator.HasNext() {
		result, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		var record KYCRecord
		if err := json.Unmarshal(result.Value, &record); err != nil {
			return nil, err
		}
		records = append(records, &record)
	}
	return records, nil
}

// GetKYCHistory returns the full transaction history for a KYC record.
func (c *KYCContract) GetKYCHistory(
	ctx contractapi.TransactionContextInterface,
	id string,
) ([]*HistoryEntry, error) {
	iterator, err := ctx.GetStub().GetHistoryForKey(id)
	if err != nil {
		return nil, fmt.Errorf("failed to get history for %q: %w", id, err)
	}
	defer iterator.Close()

	entries := make([]*HistoryEntry, 0)
	for iterator.HasNext() {
		result, err := iterator.Next()
		if err != nil {
			return nil, err
		}

		var ts string
		if result.Timestamp != nil {
			ts = time.Unix(result.Timestamp.Seconds, int64(result.Timestamp.Nanos)).UTC().Format(time.RFC3339)
		}

		entry := &HistoryEntry{
			TxID:      result.TxId,
			Timestamp: ts,
			IsDelete:  result.IsDelete,
		}

		if !result.IsDelete && len(result.Value) > 0 {
			var record KYCRecord
			if err := json.Unmarshal(result.Value, &record); err == nil {
				entry.Record = &record
			}
		}

		entries = append(entries, entry)
	}
	return entries, nil
}

// QueryByStatus returns all KYC records with a given status using a CouchDB rich query.
func (c *KYCContract) QueryByStatus(
	ctx contractapi.TransactionContextInterface,
	status string,
) ([]*KYCRecord, error) {
	queryBytes, err := json.Marshal(map[string]interface{}{
		"selector": map[string]string{"status": status},
	})
	if err != nil {
		return nil, err
	}

	iterator, err := ctx.GetStub().GetQueryResult(string(queryBytes))
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	records := make([]*KYCRecord, 0)
	for iterator.HasNext() {
		result, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		var record KYCRecord
		if err := json.Unmarshal(result.Value, &record); err != nil {
			return nil, err
		}
		records = append(records, &record)
	}
	return records, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func getRecord(ctx contractapi.TransactionContextInterface, id string) (*KYCRecord, error) {
	if id == "" {
		return nil, fmt.Errorf("id must be non-empty")
	}
	data, err := ctx.GetStub().GetState(id)
	if err != nil {
		return nil, fmt.Errorf("failed to read state: %w", err)
	}
	if data == nil {
		return nil, fmt.Errorf("KYC record %q not found", id)
	}
	var record KYCRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("failed to unmarshal record: %w", err)
	}
	return &record, nil
}

func putRecord(ctx contractapi.TransactionContextInterface, record *KYCRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("failed to marshal record: %w", err)
	}
	return ctx.GetStub().PutState(record.ID, data)
}

// txTimestamp returns the transaction timestamp as RFC 3339.
// Using the stub timestamp (not time.Now) ensures all peers produce identical state.
func txTimestamp(ctx contractapi.TransactionContextInterface) (string, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("failed to get transaction timestamp: %w", err)
	}
	return time.Unix(ts.Seconds, int64(ts.Nanos)).UTC().Format(time.RFC3339), nil
}

// isValidDID performs a lightweight structural check: did:<method>:<identifier>
func isValidDID(did string) bool {
	parts := strings.SplitN(did, ":", 3)
	return len(parts) == 3 && parts[0] == "did" && parts[1] != "" && parts[2] != ""
}
