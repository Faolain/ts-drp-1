# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase-6b-settlement-progress-red.pw.ts >> Chromium preserves atomic settlement progress and exact CAS refusal across reopen
- Location: packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts:35:1

# Error details

```
Error: D110C_F5B0U_BROWSER_zero-origin

expect(received).toEqual(expected) // deep equality

- Expected  - 82
+ Received  +  4

@@ -1,49 +1,10 @@
  Object {
    "after": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -79,19 +40,19 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 1,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "attempt": Object {
-     "errorCode": null,
-     "ok": true,
+     "errorCode": "ISSUANCE_INVALID_ARGUMENT",
+     "ok": false,
    },
    "before": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
@@ -153,49 +114,10 @@
    "outboxSequences": Array [],
    "reopened": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -231,11 +153,11 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 1,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
```

```
Error: D110C_F5B0U_BROWSER_nonempty-origin

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

@@ -47,11 +47,11 @@
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "attempt": Object {
-     "errorCode": "ISSUANCE_RETRY_REQUIRED",
+     "errorCode": "ISSUANCE_INVALID_ARGUMENT",
      "ok": false,
    },
    "before": Object {
      "entries": Array [
        Object {
```

```
Error: D110C_F5B0U_BROWSER_partial

expect(received).toEqual(expected) // deep equality

- Expected  - 143
+ Received  +  10

@@ -1,55 +1,10 @@
  Object {
    "after": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [
-             Object {
-               "lastLogicalTime": 7,
-               "replacementSequence": 0,
-               "throughIntent": 1,
-             },
-           ],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -85,63 +40,24 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 2,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "attempt": Object {
-     "errorCode": null,
-     "ok": true,
+     "errorCode": "ISSUANCE_COMMIT_INVALID",
+     "ok": false,
    },
    "before": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -177,80 +93,31 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 1,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "beforeLineage": Object {
      "exhausted": false,
      "next": 0,
    },
-   "issuedSequences": Array [
-     0,
-   ],
+   "issuedSequences": Array [],
    "lineage": Object {
      "exhausted": false,
-     "next": 1,
+     "next": 0,
    },
    "name": "partial",
-   "outboxSequences": Array [
-     0,
-   ],
+   "outboxSequences": Array [],
    "reopened": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [
-             Object {
-               "lastLogicalTime": 7,
-               "replacementSequence": 0,
-               "throughIntent": 1,
-             },
-           ],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -286,11 +153,11 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 2,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
@@ -298,10 +165,10 @@
      Object {
        "errorCode": null,
        "ok": true,
      },
      Object {
-       "errorCode": null,
-       "ok": true,
+       "errorCode": "ISSUANCE_INVALID_ARGUMENT",
+       "ok": false,
      },
    ],
  }
```

```
Error: D110C_F5B0U_BROWSER_final

expect(received).toEqual(expected) // deep equality

- Expected  - 166
+ Received  +  15

@@ -1,61 +1,11 @@
  Object {
    "after": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [
-             Object {
-               "lastLogicalTime": 7,
-               "replacementSequence": 0,
-               "throughIntent": 1,
-             },
-             Object {
-               "lastLogicalTime": 9,
-               "replacementSequence": 1,
-               "throughIntent": 2,
-             },
-           ],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
-         "replacementSequence": 1,
+         "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
            209,
@@ -90,69 +40,24 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 3,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "attempt": Object {
-     "errorCode": null,
-     "ok": true,
+     "errorCode": "ISSUANCE_COMMIT_INVALID",
+     "ok": false,
    },
    "before": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [
-             Object {
-               "lastLogicalTime": 7,
-               "replacementSequence": 0,
-               "throughIntent": 1,
-             },
-           ],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
          "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
@@ -188,88 +93,32 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 2,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
    "beforeLineage": Object {
      "exhausted": false,
-     "next": 1,
+     "next": 0,
    },
-   "issuedSequences": Array [
-     0,
-     1,
-   ],
+   "issuedSequences": Array [],
    "lineage": Object {
      "exhausted": false,
-     "next": 2,
+     "next": 0,
    },
    "name": "final",
-   "outboxSequences": Array [
-     0,
-     1,
-   ],
+   "outboxSequences": Array [],
    "reopened": Object {
      "entries": Array [
        Object {
          "disposition": "rebase",
-         "replacementProgress": Object {
-           "chunks": Array [
-             Object {
-               "lastLogicalTime": 7,
-               "replacementSequence": 0,
-               "throughIntent": 1,
-             },
-             Object {
-               "lastLogicalTime": 9,
-               "replacementSequence": 1,
-               "throughIntent": 2,
-             },
-           ],
-           "intentCount": 2,
-           "intentDigest": Array [
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-             165,
-           ],
-           "version": 1,
-         },
-         "replacementSequence": 1,
+         "replacementSequence": null,
          "sourceDigest": Array [
            209,
            209,
            209,
            209,
@@ -304,11 +153,11 @@
          ],
          "sourceSequence": 7,
        },
      ],
      "fenceSequence": 4,
-     "revision": 3,
+     "revision": 0,
      "scope": Object {
        "author": "author:browser-progress",
        "objectId": "room:browser-progress",
      },
    },
@@ -316,14 +165,14 @@
      Object {
        "errorCode": null,
        "ok": true,
      },
      Object {
-       "errorCode": null,
-       "ok": true,
+       "errorCode": "ISSUANCE_INVALID_ARGUMENT",
+       "ok": false,
      },
      Object {
-       "errorCode": null,
-       "ok": true,
+       "errorCode": "ISSUANCE_COMMIT_INVALID",
+       "ok": false,
      },
    ],
  }
```

# Test source

```ts
  53  | 		revision: number,
  54  | 		chunks?: readonly unknown[],
  55  | 		replacementSequence: number | null = null
  56  | 	): unknown => ({
  57  | 		entries: [
  58  | 			{
  59  | 				disposition: "rebase",
  60  | 				...(chunks === undefined
  61  | 					? {}
  62  | 					: {
  63  | 							replacementProgress: {
  64  | 								chunks,
  65  | 								intentCount: 2,
  66  | 								intentDigest: Array.from({ length: 32 }, () => 0xa5),
  67  | 								version: 1,
  68  | 							},
  69  | 						}),
  70  | 				replacementSequence,
  71  | 				sourceDigest: Array.from({ length: 32 }, () => 0xd1),
  72  | 				sourceSequence: 7,
  73  | 			},
  74  | 		],
  75  | 		fenceSequence: 4,
  76  | 		revision,
  77  | 		scope: { author: "author:browser-progress", objectId: "room:browser-progress" },
  78  | 	});
  79  | 	const first = { lastLogicalTime: 7, replacementSequence: 0, throughIntent: 1 };
  80  | 	const second = { lastLogicalTime: 9, replacementSequence: 1, throughIntent: 2 };
  81  | 	const vectors = [
  82  | 		{
  83  | 			name: "zero-origin",
  84  | 			setup: [ok],
  85  | 			attempt: ok,
  86  | 			before: expectedPlan(0),
  87  | 			beforeLineage: lineage(0),
  88  | 			after: expectedPlan(1, []),
  89  | 			lineage: lineage(0),
  90  | 			issuedSequences: [],
  91  | 			outboxSequences: [],
  92  | 		},
  93  | 		{
  94  | 			name: "nonempty-origin",
  95  | 			setup: [ok],
  96  | 			attempt: { ok: false, errorCode: "ISSUANCE_RETRY_REQUIRED" },
  97  | 			before: expectedPlan(0),
  98  | 			beforeLineage: lineage(0),
  99  | 			after: expectedPlan(0),
  100 | 			lineage: lineage(0),
  101 | 			issuedSequences: [],
  102 | 			outboxSequences: [],
  103 | 		},
  104 | 		{
  105 | 			name: "partial",
  106 | 			setup: [ok, ok],
  107 | 			attempt: ok,
  108 | 			before: expectedPlan(1, []),
  109 | 			beforeLineage: lineage(0),
  110 | 			after: expectedPlan(2, [first]),
  111 | 			lineage: lineage(1),
  112 | 			issuedSequences: [0],
  113 | 			outboxSequences: [0],
  114 | 		},
  115 | 		{
  116 | 			name: "final",
  117 | 			setup: [ok, ok, ok],
  118 | 			attempt: ok,
  119 | 			before: expectedPlan(2, [first]),
  120 | 			beforeLineage: lineage(1),
  121 | 			after: expectedPlan(3, [first, second], 1),
  122 | 			lineage: lineage(2),
  123 | 			issuedSequences: [0, 1],
  124 | 			outboxSequences: [0, 1],
  125 | 		},
  126 | 		{
  127 | 			name: "stale-revision",
  128 | 			setup: [ok, ok],
  129 | 			attempt: { ok: false, errorCode: "ISSUANCE_RETRY_REQUIRED" },
  130 | 			before: expectedPlan(1),
  131 | 			beforeLineage: lineage(0),
  132 | 			after: expectedPlan(1),
  133 | 			lineage: lineage(0),
  134 | 			issuedSequences: [],
  135 | 			outboxSequences: [],
  136 | 		},
  137 | 		{
  138 | 			name: "inexact-revision",
  139 | 			setup: [ok],
  140 | 			attempt: { ok: false, errorCode: "ISSUANCE_INVALID_ARGUMENT" },
  141 | 			before: expectedPlan(0),
  142 | 			beforeLineage: lineage(0),
  143 | 			after: expectedPlan(0),
  144 | 			lineage: lineage(0),
  145 | 			issuedSequences: [],
  146 | 			outboxSequences: [],
  147 | 		},
  148 | 	];
  149 | 	expect(result).toHaveLength(vectors.length);
  150 | 	for (const [index, expected] of vectors.entries()) {
  151 | 		expect
  152 | 			.soft(result[index], "D110C_F5B0U_BROWSER_" + expected.name)
> 153 | 			.toEqual({ ...expected, reopened: expected.after });
      |     ^ Error: D110C_F5B0U_BROWSER_final
  154 | 	}
  155 | });
  156 | 
```