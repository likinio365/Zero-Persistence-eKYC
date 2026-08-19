import React from 'react';
import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <>
      <h1>KYC Decentralized System</h1>

      <div className="home-intro">
        <p>
          Submit identity documents for on-chain verification. Documents are encrypted with
          AES-256-GCM and stored on IPFS. Verification status is immutably tracked on
          Hyperledger Fabric, and approved identities receive a Verifiable Credential
          anchored on Hyperledger Indy.
        </p>
        <p>
          Your data is never stored in plain text. Only the encrypted IPFS CID is written
          to the ledger — no personal information appears on-chain.
        </p>
      </div>

      <div className="home-actions">
        <Link to="/submit" className="btn btn-primary">Start KYC Submission</Link>
        <Link to="/status" className="btn btn-outline">Check Existing Application</Link>
      </div>
    </>
  );
}
