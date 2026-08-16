# Slice 05: Reconnect and Converge

Close one client, reopen its real IndexedDB authorization, issuance and journal
state, recover before subscription, exchange another operation and assert both
clients converge on the same accepted durable transcript.

This proves warm durable reconnect for the exercised room history. General
offline-gap repair and dynamic writer authorization remain separate work.
