declare namespace NodeJS {
  interface ProcessEnv {
    // Vector Network Endpoints
    VECTOR_OGMIOS_URL: string;
    VECTOR_KOIOS_URL: string;
    VECTOR_SUBMIT_URL: string;
    VECTOR_EXPLORER_URL: string;

    // Safety Limits
    VECTOR_SPEND_LIMIT_PER_TX: string;
    VECTOR_SPEND_LIMIT_DAILY: string;

    // Audit Log
    VECTOR_AUDIT_LOG_PATH: string;
  }
}
