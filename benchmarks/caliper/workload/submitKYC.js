/**
 * Hyperledger Caliper workload: SubmitKYC
 * Μετράει pure Fabric TPS χωρίς HTTP/IPFS/Vault overhead.
 */

'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class SubmitKYCWorkload extends WorkloadModuleBase {
  constructor() {
    super();
    this.txIndex = 0;
  }

  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    this.workerIndex = workerIndex;
  }

  async submitTransaction() {
    const kycId   = `caliper-${this.workerIndex}-${this.txIndex++}-${Date.now()}`;
    const did     = `did:indy:test:caliper${this.workerIndex}${this.txIndex}`;
    const ipfsHash = `QmCaliper${Math.random().toString(36).slice(2, 12)}`;

    const request = {
      contractId: 'kyccc',
      contractFunction: 'SubmitKYC',
      contractArguments: [kycId, did, ipfsHash],
      readOnly: false,
    };

    await this.sutAdapter.sendRequests(request);
  }
}

module.exports.createWorkloadModule = () => new SubmitKYCWorkload();
