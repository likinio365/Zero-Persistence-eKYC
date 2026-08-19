package main

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/hyperledger/fabric-chaincode-go/shimtest"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// ── test helpers ──────────────────────────────────────────────────────────────

func newStub(t *testing.T) *shimtest.MockStub {
	t.Helper()
	cc, err := contractapi.NewChaincode(&KYCContract{})
	if err != nil {
		t.Fatalf("contractapi.NewChaincode: %v", err)
	}
	return shimtest.NewMockStub("kyc-test", cc)
}

// invoke calls a chaincode function in a mock transaction and returns the payload.
func invoke(stub *shimtest.MockStub, txID, fn string, args ...string) ([]byte, error) {
	params := make([][]byte, len(args)+1)
	params[0] = []byte(fn)
	for i, a := range args {
		params[i+1] = []byte(a)
	}
	resp := stub.MockInvoke(txID, params)
	if resp.Status != 200 {
		return nil, fmt.Errorf("%s", resp.Message)
	}
	return resp.Payload, nil
}

func mustInvoke(t *testing.T, stub *shimtest.MockStub, txID, fn string, args ...string) []byte {
	t.Helper()
	payload, err := invoke(stub, txID, fn, args...)
	if err != nil {
		t.Fatalf("%s(%v): %v", fn, args, err)
	}
	return payload
}

func mustGetRecord(t *testing.T, stub *shimtest.MockStub, id string) *KYCRecord {
	t.Helper()
	payload := mustInvoke(t, stub, "tx-get-"+id, "GetKYC", id)
	var rec KYCRecord
	if err := json.Unmarshal(payload, &rec); err != nil {
		t.Fatalf("unmarshal KYCRecord: %v", err)
	}
	return &rec
}

// ── SubmitKYC ─────────────────────────────────────────────────────────────────

func TestSubmitKYC_CreatesRecord(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc123", "QmFakeHash")

	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.Status != StatusPending {
		t.Errorf("status = %q, want PENDING", rec.Status)
	}
	if rec.DID != "did:indy:abc123" {
		t.Errorf("did = %q", rec.DID)
	}
	if rec.IPFSHash != "QmFakeHash" {
		t.Errorf("ipfsHash = %q", rec.IPFSHash)
	}
	if rec.CreatedAt == "" || rec.UpdatedAt == "" {
		t.Error("timestamps must be non-empty")
	}
	if rec.CreatedAt != rec.UpdatedAt {
		t.Error("createdAt and updatedAt should match on creation")
	}
}

func TestSubmitKYC_RejectsDuplicate(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	if _, err := invoke(stub, "tx2", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1"); err == nil {
		t.Fatal("expected error for duplicate id")
	}
}

func TestSubmitKYC_RejectsEmptyArgs(t *testing.T) {
	stub := newStub(t)
	cases := [][]string{
		{"", "did:indy:x", "Qm1"},
		{"id1", "", "Qm1"},
		{"id1", "did:indy:x", ""},
	}
	for i, c := range cases {
		if _, err := invoke(stub, fmt.Sprintf("tx%d", i), "SubmitKYC", c...); err == nil {
			t.Errorf("expected error for empty args %v", c)
		}
	}
}

func TestSubmitKYC_RejectsInvalidDID(t *testing.T) {
	stub := newStub(t)
	badDIDs := []string{
		"not-a-did",
		"did:onlytwoparts",
		"did::empty-method",
		"did:method:",
		"DID:indy:abc",
	}
	for i, did := range badDIDs {
		if _, err := invoke(stub, fmt.Sprintf("tx%d", i), "SubmitKYC", "id1", did, "Qm1"); err == nil {
			t.Errorf("expected DID validation failure for %q", did)
		}
	}
}

func TestSubmitKYC_AcceptsValidDIDFormats(t *testing.T) {
	stub := newStub(t)
	cases := []struct{ id, did string }{
		{"a", "did:indy:abc123"},
		{"b", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"},
		{"c", "did:web:example.com:user:alice"},
	}
	for _, c := range cases {
		if _, err := invoke(stub, "tx-"+c.id, "SubmitKYC", c.id, c.did, "QmHash"); err != nil {
			t.Errorf("valid DID %q rejected: %v", c.did, err)
		}
	}
}

// ── VerifyKYC ─────────────────────────────────────────────────────────────────

func TestVerifyKYC_PendingToVerified(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-123")

	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.Status != StatusVerified {
		t.Errorf("status = %q, want VERIFIED", rec.Status)
	}
	if rec.CredDefID != "cred-def-123" {
		t.Errorf("credDefId = %q", rec.CredDefID)
	}
}

func TestVerifyKYC_UpdatedAtIsSet(t *testing.T) {
	// MockStub returns the same timestamp for all transactions, so we cannot
	// assert that updatedAt changed — only that it is a non-empty RFC 3339 string.
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.UpdatedAt == "" {
		t.Error("updatedAt must be set after verify")
	}
}

func TestVerifyKYC_RejectsAlreadyVerified(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	if _, err := invoke(stub, "tx3", "VerifyKYC", "kyc-1", "cred-def-2"); err == nil {
		t.Fatal("expected error: cannot re-verify a VERIFIED record")
	}
}

func TestVerifyKYC_RejectsRevoked(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	mustInvoke(t, stub, "tx3", "RevokeKYC", "kyc-1")
	if _, err := invoke(stub, "tx4", "VerifyKYC", "kyc-1", "cred-def-2"); err == nil {
		t.Fatal("expected error: cannot verify a REVOKED record")
	}
}

func TestVerifyKYC_RejectsMissingRecord(t *testing.T) {
	stub := newStub(t)
	if _, err := invoke(stub, "tx1", "VerifyKYC", "ghost", "cred-def-1"); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestVerifyKYC_RejectsEmptyCredDef(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	if _, err := invoke(stub, "tx2", "VerifyKYC", "kyc-1", ""); err == nil {
		t.Fatal("expected error for empty credDefID")
	}
}

// ── RejectKYC ─────────────────────────────────────────────────────────────────

func TestRejectKYC_PendingToRejected(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:test:Alice", "Qm1")
	mustInvoke(t, stub, "tx2", "RejectKYC", "kyc-1", "Documents unclear")

	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.Status != StatusRejected {
		t.Errorf("status = %q, want REJECTED", rec.Status)
	}
	if rec.RejectionReason != "Documents unclear" {
		t.Errorf("rejectionReason = %q", rec.RejectionReason)
	}
}

func TestRejectKYC_AllowsEmptyReason(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:test:Alice", "Qm1")
	mustInvoke(t, stub, "tx2", "RejectKYC", "kyc-1", "")

	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.Status != StatusRejected {
		t.Errorf("status = %q, want REJECTED", rec.Status)
	}
}

func TestRejectKYC_RejectsVerified(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:test:Alice", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	if _, err := invoke(stub, "tx3", "RejectKYC", "kyc-1", "late"); err == nil {
		t.Fatal("expected error: cannot reject a VERIFIED record")
	}
}

func TestRejectKYC_IsTerminal(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:test:Alice", "Qm1")
	mustInvoke(t, stub, "tx2", "RejectKYC", "kyc-1", "fraud")
	if _, err := invoke(stub, "tx3", "VerifyKYC", "kyc-1", "cred-def"); err == nil {
		t.Fatal("expected error: REJECTED is terminal")
	}
	if _, err := invoke(stub, "tx4", "RejectKYC", "kyc-1", "again"); err == nil {
		t.Fatal("expected error: REJECTED is terminal")
	}
}

// ── RevokeKYC ─────────────────────────────────────────────────────────────────

func TestRevokeKYC_VerifiedToRevoked(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	mustInvoke(t, stub, "tx3", "RevokeKYC", "kyc-1")

	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.Status != StatusRevoked {
		t.Errorf("status = %q, want REVOKED", rec.Status)
	}
}

func TestRevokeKYC_RejectsPending(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	if _, err := invoke(stub, "tx2", "RevokeKYC", "kyc-1"); err == nil {
		t.Fatal("expected error: cannot revoke a PENDING record")
	}
}

func TestRevokeKYC_RejectsAlreadyRevoked(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "Qm1")
	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-1")
	mustInvoke(t, stub, "tx3", "RevokeKYC", "kyc-1")
	if _, err := invoke(stub, "tx4", "RevokeKYC", "kyc-1"); err == nil {
		t.Fatal("expected error: REVOKED is terminal")
	}
}

func TestRevokeKYC_RejectsMissingRecord(t *testing.T) {
	stub := newStub(t)
	if _, err := invoke(stub, "tx1", "RevokeKYC", "ghost"); err == nil {
		t.Fatal("expected not-found error")
	}
}

// ── QueryByStatus ─────────────────────────────────────────────────────────────

func TestQueryByStatus_ReturnsPendingRecords(t *testing.T) {
	// MockStub does not implement GetQueryResult (CouchDB-only).
	// QueryByStatus is covered by integration tests against a live peer.
	t.Skip("CouchDB rich queries require a live peer — skipped in unit tests")
}

func TestQueryByStatus_EmptyWhenNoneMatch(t *testing.T) {
	t.Skip("CouchDB rich queries require a live peer — skipped in unit tests")
}

// ── GetKYC ────────────────────────────────────────────────────────────────────

func TestGetKYC_ReturnsRecord(t *testing.T) {
	stub := newStub(t)
	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:abc", "QmHash")
	rec := mustGetRecord(t, stub, "kyc-1")
	if rec.ID != "kyc-1" {
		t.Errorf("id = %q", rec.ID)
	}
}

func TestGetKYC_RejectsUnknownID(t *testing.T) {
	stub := newStub(t)
	if _, err := invoke(stub, "tx1", "GetKYC", "ghost"); err == nil {
		t.Fatal("expected not-found error")
	}
}

// ── full lifecycle ─────────────────────────────────────────────────────────────

func TestFullLifecycle(t *testing.T) {
	stub := newStub(t)

	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:user1", "QmDoc")
	if r := mustGetRecord(t, stub, "kyc-1"); r.Status != StatusPending {
		t.Fatalf("after Submit: got %q", r.Status)
	}

	mustInvoke(t, stub, "tx2", "VerifyKYC", "kyc-1", "cred-def-abc")
	if r := mustGetRecord(t, stub, "kyc-1"); r.Status != StatusVerified {
		t.Fatalf("after Verify: got %q", r.Status)
	}

	mustInvoke(t, stub, "tx3", "RevokeKYC", "kyc-1")
	if r := mustGetRecord(t, stub, "kyc-1"); r.Status != StatusRevoked {
		t.Fatalf("after Revoke: got %q", r.Status)
	}

	// REVOKED is terminal — neither transition is allowed
	if _, err := invoke(stub, "tx4", "VerifyKYC", "kyc-1", "new-cred"); err == nil {
		t.Fatal("expected error: REVOKED → VERIFIED is not a valid transition")
	}
	if _, err := invoke(stub, "tx5", "RevokeKYC", "kyc-1"); err == nil {
		t.Fatal("expected error: REVOKED → REVOKED is not a valid transition")
	}
}

func TestFullLifecycle_RejectPath(t *testing.T) {
	stub := newStub(t)

	mustInvoke(t, stub, "tx1", "SubmitKYC", "kyc-1", "did:indy:user2", "QmDoc")
	if r := mustGetRecord(t, stub, "kyc-1"); r.Status != StatusPending {
		t.Fatalf("after Submit: got %q", r.Status)
	}

	mustInvoke(t, stub, "tx2", "RejectKYC", "kyc-1", "Passport expired")
	if r := mustGetRecord(t, stub, "kyc-1"); r.Status != StatusRejected {
		t.Fatalf("after Reject: got %q", r.Status)
	}

	// REJECTED is terminal
	if _, err := invoke(stub, "tx3", "VerifyKYC", "kyc-1", "cred"); err == nil {
		t.Fatal("expected error: REJECTED → VERIFIED is not a valid transition")
	}
}
