import { doc, getDocFromServer, FirestoreError, type Firestore } from 'firebase/firestore';

export interface ProofVerificationResult {
  verified: boolean;
  denialReason?: string;
  error?: string;
  code?: string;
}

/**
 * Strict evaluation of claims.admin.
 * Invariant: Must strictly be boolean true.
 * Rejects: undefined, null, false, "true", 1, {}, []
 */
export function evaluateAdminClaim(claims: Record<string, unknown> | undefined | null): boolean {
  if (!claims || typeof claims !== 'object') {
    return false;
  }
  return claims.admin === true;
}

/**
 * Server-Authoritative Authorization Proof (Section 7)
 *
 * Before treating any session as verified admin, requires a successful server-side
 * read of synthetic `dispatch_config/main` from the selected canonical Firestore instance.
 *
 * According to firestore.rules:
 *   match /dispatch_config/{document} {
 *     allow read: if isAdmin();
 *     allow write: if false;
 *   }
 *
 * Non-admins receive `permission-denied`.
 * Admins with real tokens receive document snapshot.
 * Protected client writes remain rejected for everyone.
 */
export async function verifyServerAuthoritativeProof(db: Firestore): Promise<ProofVerificationResult> {
  try {
    const configDocRef = doc(db, 'dispatch_config', 'main');
    // Force read strictly from Firestore emulator/server to bypass local client cache
    const snapshot = await getDocFromServer(configDocRef);

    if (!snapshot.exists()) {
      return {
        verified: false,
        denialReason: 'Synthetic dispatch_config/main document does not exist in Firestore emulator. Run bootstrap fixtures.',
        code: 'not-found',
      };
    }

    return { verified: true };
  } catch (err: unknown) {
    if (err instanceof FirestoreError) {
      if (err.code === 'permission-denied') {
        return {
          verified: false,
          denialReason: 'Server-side authorization rejected by Firestore security rules (permission-denied).',
          code: 'permission-denied',
        };
      }
      return {
        verified: false,
        error: `Firestore error during authorization proof: ${err.message}`,
        code: err.code,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      error: `Unexpected error during authorization proof: ${message}`,
      code: 'unknown',
    };
  }
}
