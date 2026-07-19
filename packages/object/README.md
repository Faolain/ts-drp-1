# DRP Objects

This package provides a simple implementation of Distributed Real-Time Programs (DRPs).
DRPs are a type of composable programs that can be replicated across multiple nodes in a network,
and can be updated concurrently by multiple clients without the need for coordination.

## Usage

This package is intended to implement all the fuctionalities for the creation of custom DRPs.
Basic operations for synchronization are provided, but the implementation of the actual program behavior is left to the app developer.

For starting, you can install it using:

```bash
pnpm install @ts-drp/object
```

## CPU profiling

### Prerequisites

- Go's `pprof` tooling
- Graphviz when rendering an SVG

### How to run

```bash
# One object growing to 1,000 vertices
pnpm run flamegraph -- 1 1000 false flamegraph-growth.pprof

# Two 500-vertex objects merged in both directions
pnpm run flamegraph -- 2 500 true flamegraph-merge.pprof
```

### Visualize Profile

```bash
go tool pprof -http=:8080 flamegraph-growth.pprof
```

Open `http://localhost:8080` and select the flame-graph view. The scheduled
CPU-profile workflow also uploads the raw profiles and rendered SVG call graphs.
