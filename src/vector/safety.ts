import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SpendLimits, SpendStatus, AuditEntry } from './types.js';

const VECTOR_SPEND_LIMIT_PER_TX = parseInt(process.env.VECTOR_SPEND_LIMIT_PER_TX || '100000000'); // 100 ADA
const VECTOR_SPEND_LIMIT_DAILY = parseInt(process.env.VECTOR_SPEND_LIMIT_DAILY || '500000000'); // 500 ADA

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');

export class SafetyLayer {
  private dailySpent: number = 0;
  private dailyResetTime: number;
  private auditLog: AuditEntry[] = [];
  private limits: SpendLimits;
  private auditLogPath: string;

  constructor() {
    this.limits = {
      perTransaction: VECTOR_SPEND_LIMIT_PER_TX,
      daily: VECTOR_SPEND_LIMIT_DAILY,
    };
    // Reset daily limit at midnight UTC
    this.dailyResetTime = this.getNextMidnightUTC();

    // Audit log file persistence
    this.auditLogPath = process.env.VECTOR_AUDIT_LOG_PATH
      ? resolve(process.env.VECTOR_AUDIT_LOG_PATH)
      : resolve(projectRoot, 'vector-audit-log.json');

    this.loadAuditLog();
  }

  private getNextMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime();
  }

  private checkAndResetDaily(): void {
    if (Date.now() >= this.dailyResetTime) {
      this.dailySpent = 0;
      this.dailyResetTime = this.getNextMidnightUTC();
    }
  }

  private loadAuditLog(): void {
    try {
      if (existsSync(this.auditLogPath)) {
        const data = readFileSync(this.auditLogPath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.auditLog = parsed;
          // Recalculate dailySpent from today's entries (survives server restart)
          this.recalculateDailySpent();
        }
      }
    } catch (err) {
      console.error(`Warning: Could not load audit log from ${this.auditLogPath}:`, err);
      this.auditLog = [];
    }
  }

  private recalculateDailySpent(): void {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    this.dailySpent = 0;
    for (const entry of this.auditLog) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime >= todayStartMs) {
        this.dailySpent += entry.amountLovelace;
      }
    }
  }

  private persistAuditLog(): void {
    try {
      writeFileSync(this.auditLogPath, JSON.stringify(this.auditLog, null, 2));
    } catch (err) {
      console.error(`Warning: Could not persist audit log to ${this.auditLogPath}:`, err);
    }
  }

  checkTransaction(amountLovelace: number): { allowed: boolean; reason?: string } {
    this.checkAndResetDaily();

    if (amountLovelace > this.limits.perTransaction) {
      return {
        allowed: false,
        reason: `Transaction amount ${(amountLovelace / 1_000_000).toFixed(6)} ADA exceeds per-transaction limit of ${(this.limits.perTransaction / 1_000_000).toFixed(6)} ADA`,
      };
    }

    if (this.dailySpent + amountLovelace > this.limits.daily) {
      const remaining = this.limits.daily - this.dailySpent;
      return {
        allowed: false,
        reason: `Transaction would exceed daily spend limit. Daily limit: ${(this.limits.daily / 1_000_000).toFixed(6)} ADA, already spent: ${(this.dailySpent / 1_000_000).toFixed(6)} ADA, remaining: ${(remaining / 1_000_000).toFixed(6)} ADA`,
      };
    }

    return { allowed: true };
  }

  recordTransaction(txHash: string, amountLovelace: number, recipient: string): void {
    this.checkAndResetDaily();
    this.dailySpent += amountLovelace;

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      txHash,
      amountLovelace,
      recipient,
      action: 'send',
    });

    this.persistAuditLog();
  }

  getSpendStatus(): SpendStatus {
    this.checkAndResetDaily();
    return {
      perTransactionLimit: this.limits.perTransaction,
      dailyLimit: this.limits.daily,
      dailySpent: this.dailySpent,
      dailyRemaining: Math.max(0, this.limits.daily - this.dailySpent),
      resetTime: new Date(this.dailyResetTime).toISOString(),
    };
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }
}

// Singleton instance
export const safetyLayer = new SafetyLayer();
