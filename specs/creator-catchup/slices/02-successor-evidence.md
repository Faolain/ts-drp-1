# Bounded native attachment receipt

Persist one received attachment receipt binding the exact old local native head and source trust, target checkpoint proof and final snapshot. Reuse the snapshot recovery owner’s strict receipt custody when its derived byte bound fits; do not append a certificate chain to the seven-reference AHE closure. Source proof retention lasts until the last unresolved operation or rollback consumer releases it, not for a fixed number of epochs.

The receipt is an untrusted carrier on reopen. The source and target proof owners re-verify every byte and current native currency before effects. Reserve its bounded bytes and every retained old source dependency before the native publication sequence; failure leaves the old state usable and pending work retained.

Verify SQLite and IndexedDB parity, quota refusal before effect, tampering, creator/recipient reopen and crash around receipt publication. Record the exact capacity calculation and native owner decision before implementing the layout.
