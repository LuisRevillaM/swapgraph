import {
  getPolicyIntegritySigningActiveKeyId,
  getPolicyIntegritySigningPublicKeys
} from '../crypto/policyIntegritySigning.mjs';

function correlationIdForKeys() {
  return 'corr_keys_policy_integrity_signing';
}

export class PolicyIntegritySigningService {
  getSigningKeys() {
    return {
      ok: true,
      body: {
        correlation_id: correlationIdForKeys(),
        active_key_id: getPolicyIntegritySigningActiveKeyId(),
        keys: getPolicyIntegritySigningPublicKeys()
      }
    };
  }
}
