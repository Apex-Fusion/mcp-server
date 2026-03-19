// Vector-specific type definitions

export interface VectorToken {
  unit: string;
  name: string;
  quantity: string;
}

export interface VectorWalletInfo {
  address: string;
  utxoCount: number;
  ada: string;
  tokens: VectorToken[];
}

export interface VectorAdaTransactionResult {
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  amount: number;
  links: {
    explorer: string;
  };
}

export interface VectorTokenTransactionResult {
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  token: {
    policyId: string;
    name: string;
    amount: string;
  };
  ada: string;
  links: {
    explorer: string;
  };
}

export interface SpendLimits {
  perTransaction: number; // lovelace
  daily: number; // lovelace
}

export interface SpendStatus {
  perTransactionLimit: number;
  dailyLimit: number;
  dailySpent: number;
  dailyRemaining: number;
  resetTime: string;
}

export interface AuditEntry {
  timestamp: string;
  txHash: string;
  amountLovelace: number;
  recipient: string;
  action: string;
}

// --- Build Transaction ---

export interface TxOutput {
  address: string;
  lovelace: number;
  assets?: Record<string, string>; // unit -> quantity
}

export interface VectorBuildTransactionResult {
  txCbor: string;
  txHash: string;
  fee: string;
  feeAda: string;
  outputCount: number;
  totalAda: string;
  submitted: boolean;
  links?: {
    explorer: string;
  };
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

// --- Deploy Contract ---

export interface VectorDeployContractResult {
  txHash: string;
  scriptAddress: string;
  scriptHash: string;
  scriptType: string;
  links: {
    explorer: string;
  };
}

// --- Interact Contract ---

export interface VectorInteractContractResult {
  txHash: string;
  scriptAddress: string;
  action: 'spend' | 'lock';
  links: {
    explorer: string;
  };
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
