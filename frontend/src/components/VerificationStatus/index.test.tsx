import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VerificationStatus from './index';
import type { KYCRecord } from '../../types/kyc';

const BASE: KYCRecord = {
  id: 'kyc-1',
  did: 'did:indy:test:Alice',
  status: 'PENDING',
  ipfsHash: 'bafyXXX',
  credDefId: '',
  createdAt: '2024-01-01T10:00:00Z',
  updatedAt: '2024-01-01T11:00:00Z',
};

// ── rendering ─────────────────────────────────────────────────────────────────

describe('VerificationStatus — PENDING', () => {
  it('shows the "Pending Review" label', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByRole('status')).toHaveTextContent('Pending Review');
  });

  it('displays the record id', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByText('kyc-1')).toBeInTheDocument();
  });

  it('displays the DID', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByText('did:indy:test:Alice')).toBeInTheDocument();
  });

  it('displays the IPFS CID', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByText('bafyXXX')).toBeInTheDocument();
  });

  it('does not render VC notice or revoke notice', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('sets data-status attribute to PENDING', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByTestId('status-card')).toHaveAttribute('data-status', 'PENDING');
  });
});

describe('VerificationStatus — VERIFIED', () => {
  const verified: KYCRecord = { ...BASE, status: 'VERIFIED', credDefId: 'cred-def-1' };

  it('shows the "Verified" label', () => {
    render(<VerificationStatus record={verified} />);
    expect(screen.getByRole('status')).toHaveTextContent('Verified');
  });

  it('shows the VC issuance notice', () => {
    render(<VerificationStatus record={verified} />);
    expect(screen.getByRole('note')).toHaveTextContent('Verifiable Credential');
  });

  it('displays the credDefId when set', () => {
    render(<VerificationStatus record={verified} />);
    expect(screen.getByText('cred-def-1')).toBeInTheDocument();
  });

  it('does not show revoke notice', () => {
    render(<VerificationStatus record={verified} />);
    expect(screen.queryByText(/revoked/i)).not.toBeInTheDocument();
  });
});

describe('VerificationStatus — REVOKED', () => {
  const revoked: KYCRecord = { ...BASE, status: 'REVOKED' };

  it('shows the "Revoked" label', () => {
    render(<VerificationStatus record={revoked} />);
    expect(screen.getByRole('status')).toHaveTextContent('Revoked');
  });

  it('shows the revocation notice', () => {
    render(<VerificationStatus record={revoked} />);
    expect(screen.getByRole('note')).toHaveTextContent('revoked');
  });

  it('does not show VC notice', () => {
    render(<VerificationStatus record={revoked} />);
    expect(screen.queryByText(/Verifiable Credential/)).not.toBeInTheDocument();
  });
});

describe('VerificationStatus — copy button', () => {
  it('renders the copy button', () => {
    render(<VerificationStatus record={BASE} />);
    expect(screen.getByLabelText('Copy application ID to clipboard')).toBeInTheDocument();
  });

  it('shows a checkmark after clicking (clipboard mock)', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
    render(<VerificationStatus record={BASE} />);
    const btn = screen.getByLabelText('Copy application ID to clipboard');
    await userEvent.click(btn);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });
});
