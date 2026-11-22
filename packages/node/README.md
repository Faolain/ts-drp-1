# DRP Node

This package provides the implementation of a DRP Node, which is a node in a network that can be connected to other nodes and exchange messages with them.
The DRP Node is the entrypoint for interacting with the DRP protocol in the network.

## Usage

DRP Node can be used using the CLI or integrated into an existing application.

### CLI

The CLI lives in the private [`@ts-drp/cli`](../cli) package (it composes this package with the
Node SQLite host, so it sits above both). It starts the explicit configured v3 Canvas receive-only daemon. Importing
its entry point does not start a host. It does not register the old bare-ID RPC.
For the executable's arguments, run:

```bash
pnpm cli --help
```

#### Trusted local configuration

The [configured host](../cli/src/v3-canvas.ts) owns the configuration schema.
The operator selects the packaged application, finite RPC messaging policy,
local SQLite directory, exact known room/genesis bindings and local author
identity. Invites authenticate before those bindings can acquire storage;
neither an invite nor RPC data selects a module, filesystem path or signing key.

```bash
pnpm cli --config local-v3-canvas.json
```

Creation must be explicitly authorized for a fresh local room. Retained rooms
use noncreating reopen; a missing file is not permission to recreate it. SQLite
head custody is mechanical and does not provide independent protection against
whole-directory rollback. The original runtime owns network configuration and
public-network acknowledgement. Network-only startup needs no fabricated room
or author identity: an empty configured room list refuses room acquisition while
retaining custom/group methods. RPC binds loopback; local completion is not a
remote delivery receipt. Shutdown joins admitted room work before releasing
native head custody and stopping the Node's keys and transport.

The [requirement-to-evidence map](../../specs/bounded-storage-lifecycle/requirements-to-evidence.md)
distinguishes this local configured component from unfinished shipping, obsolete
plane, distributed transport and device acceptance.

### Integration

To integrate the DRP Node into an existing application, you can install it using:

```bash
pnpm install @ts-drp/node
```

Then, you can import the DRP Node class and create a new instance:

```javascript
import { DRPNode } from "@ts-drp/node";

const node = new DRPNode();

// Start the node
node.start();
```
