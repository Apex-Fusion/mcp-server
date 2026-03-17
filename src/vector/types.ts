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
