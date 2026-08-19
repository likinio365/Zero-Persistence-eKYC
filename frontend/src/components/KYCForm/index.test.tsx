import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KYCForm from './index';

const noop = async () => {};

// ── rendering ─────────────────────────────────────────────────────────────────

describe('KYCForm — initial render', () => {
  it('renders the DID input', () => {
    render(<KYCForm onSubmit={noop} />);
    expect(screen.getByLabelText(/Decentralized Identifier/i)).toBeInTheDocument();
  });

  it('renders a document upload for each document type', () => {
    render(<KYCForm onSubmit={noop} />);
    expect(screen.getByText('Passport')).toBeInTheDocument();
    expect(screen.getByText('Selfie / Photo')).toBeInTheDocument();
    expect(screen.getByText('National ID')).toBeInTheDocument();
    expect(screen.getByText("Driver's License")).toBeInTheDocument();
  });

  it('submit button is disabled when DID and files are missing', () => {
    render(<KYCForm onSubmit={noop} />);
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('submit button is disabled when isLoading=true', () => {
    render(<KYCForm onSubmit={noop} isLoading />);
    expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
  });
});

// ── validation ────────────────────────────────────────────────────────────────

describe('KYCForm — validation', () => {
  it('shows an error when DID does not start with "did:"', async () => {
    render(<KYCForm onSubmit={noop} />);
    await userEvent.type(screen.getByLabelText(/Decentralized Identifier/i), 'invalid-did');
    // Bypass the disabled-button check by directly submitting the form
    fireEvent.submit(screen.getByRole('button', { name: /submit/i }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/did:/i);
  });

  it('shows missing-document error when required docs are absent', async () => {
    render(<KYCForm onSubmit={noop} />);
    await userEvent.type(screen.getByLabelText(/Decentralized Identifier/i), 'did:indy:test:Alice');
    fireEvent.submit(screen.getByRole('button', { name: /submit/i }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Passport/i);
  });
});

// ── loading state ─────────────────────────────────────────────────────────────

describe('KYCForm — loading state', () => {
  it('shows spinner and "Submitting…" text when isLoading=true', () => {
    render(<KYCForm onSubmit={noop} isLoading />);
    expect(screen.getByText(/Submitting/i)).toBeInTheDocument();
  });

  it('disables all fieldset controls while loading', () => {
    render(<KYCForm onSubmit={noop} isLoading />);
    expect(screen.getByRole('group')).toBeDisabled();
  });
});
