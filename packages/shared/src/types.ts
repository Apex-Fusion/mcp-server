// Vector-specific type definitions

// --- Build Transaction ---

export interface TxOutput {
  address: string;
  lovelace: number;
  assets?: Record<string, string>; // unit -> quantity
}

// --- Dry Run ---

export interface VectorDryRunResult {
  valid: boolean;
  fee: string;
  feeAda: string;
  executionUnits?: {
    memory: number;
    cpu: number;
  };
  error?: string;
}

// --- Transaction History ---

export interface VectorTransactionSummary {
  txHash: string;
  blockHeight: number;
  blockTime: string;
  fee: string;
}

export interface VectorTransactionHistoryResult {
  address: string;
  transactions: VectorTransactionSummary[];
  total: number;
}

// --- Keyless build results (non-custodial split, family 1) ---
// Every build_* tool returns unsigned CBOR; signing happens on the local
// signer, submission via vector_submit_transaction.

export interface VectorUnsignedBuildResult {
  txCbor: string;   // hex CBOR of the UNSIGNED transaction
  txHash: string;   // body hash — stable across signing
  fee: string;      // lovelace
  feeAda: string;
}

export interface VectorBuildDeployResult extends VectorUnsignedBuildResult {
  scriptAddress: string; scriptHash: string; scriptType: string;
}

export interface VectorBuildInteractResult extends VectorUnsignedBuildResult {
  scriptAddress: string; action: 'lock' | 'spend';
}

// --- Keyless registry builds (spec PR 7) ---

export interface VectorBuildRegisterResult extends VectorUnsignedBuildResult {
  agentId: string;
  nftAssetName: string;
  registryAddress: string;
  depositLovelace: string;
}

export interface VectorBuildAgentOpResult extends VectorUnsignedBuildResult {
  agentId: string;
  op: 'update' | 'transfer' | 'deregister';
  agentName: string;
  detail: string;
}

export interface VectorBuildMessageResult extends VectorUnsignedBuildResult {
  agentId: string;
  agentName: string;
  recipientAddress: string;
}

// --- Agent Network ---

export interface AgentProfile {
  agentId: string;        // did:vector:agent:{policyId}:{nftAssetName}
  name: string;
  description: string;
  capabilities: string[];
  framework: string;
  endpoint: string;
  registeredAt: number;   // POSIX ms timestamp
  utxoRef?: string;       // tx_hash#index of registry UTxO
  ownerVkeyHash?: string; // owner verification key hash (hex)
}

export interface AgentRegistrationResult {
  agentId: string;
  nftAssetName: string;
  txHash: string;
  links: { explorer: string };
}

export interface AgentMessageResult {
  txHash: string;
  recipientAddress: string;
  messageType: string;
  links: { explorer: string };
}

export interface AgentDeregistrationResult {
  agentId: string;
  txHash: string;
  depositReturned: string;
  links: { explorer: string };
}

export interface AgentUpdateResult {
  agentId: string;
  txHash: string;
  updatedFields: string[];
  links: { explorer: string };
}

export interface AgentTransferResult {
  agentId: string;
  txHash: string;
  newOwnerAddress: string;
  links: { explorer: string };
}

// --- Unsigned TX (transaction-crafter mode) ---

export interface UnsignedTxResult {
  txCbor: string;
  fee: string;
  feeAda: string;
}

// --- Keyless self-improvement builds (spec PR 8) ---

export interface VectorBuildStakeResult extends VectorUnsignedBuildResult {
  op: 'critique' | 'endorse';
  proposalRef: string;      // "txHash#index"
  stakeLovelace: string;
  scriptAddress: string;
  ipfsCid?: string;
  documentHash?: string;
  storageUri?: string;      // set by buildCritique only - buildEndorse has no document/URI concept
}

export interface VectorBuildProposalLockResult extends VectorUnsignedBuildResult {
  scriptAddress: string;
  stakeLovelace: string;
  storageUri: string;
  proposalHash: string;
  ipfsCid?: string;
}

export interface VectorBuildProposalSpendResult extends VectorUnsignedBuildResult {
  proposalTokenName: string;
  activityTokenName: string;
  scriptAddress: string;
  validToMs: number;        // the signing deadline the agent must beat
}
