# drp-canonical-profile-1 canonical tag codec

## Status and authority

This document is the authoritative recursive grammar for the
`drp-canonical-profile-1` tag codec. It defines one canonical encoding for each
value in the governed data domain and the validation required when decoding.
All octets in this document are unsigned.

The machine-readable companion binds to this document by SHA-256. Its binding conformance examples are
mandatory cases, but examples never override the grammar or production rules. A value or byte sequence
not listed as an example is evaluated by recursively applying these productions.

The term “reject” means that no governed value is produced. Error category names
identify conformance outcomes; implementations need not expose those names in
their public API.

## Notation and recursive production

- `octet(x)` is the single octet whose value is `x`.
- `||` concatenates byte strings.
- `repeat(n, p)` is exactly `n` consecutive instances of production `p`.
- `varuint(n)` is the unsigned integer production defined below.
- `encoded(v)` is the complete recursive encoding of `v`, including its tag.

The start production is `<value>`.

```abnf
<value> ::= <null> | <false> | <true> | <integer> | <float64> | <string> | <bytes> | <array> | <object> | <map> | <set> | <float32-array> | <float64-array> | <int32-array> | <uint32-array>
<null> ::= octet(0x00)
<false> ::= octet(0x01)
<true> ::= octet(0x02)
<integer> ::= octet(0x03) || varuint(zigzag(n))
<float64> ::= octet(0x04) || float64be(x)
<string> ::= octet(0x05) || varuint(byte-length) || utf8-scalar-bytes
<bytes> ::= octet(0x06) || varuint(byte-length) || repeat(byte-length, octet)
<array> ::= octet(0x07) || varuint(count) || repeat(count, <value>)
<object> ::= octet(0x08) || varuint(count) || repeat(count, <string> || <value>)
<map> ::= octet(0x09) || varuint(count) || repeat(count, <value> || <value>)
<set> ::= octet(0x0a) || varuint(count) || repeat(count, <value>)
<float32-array> ::= octet(0x0b) || varuint(count) || repeat(count, float32be)
<float64-array> ::= octet(0x0c) || varuint(count) || repeat(count, float64be)
<int32-array> ::= octet(0x0d) || varuint(count) || repeat(count, int32be)
<uint32-array> ::= octet(0x0e) || varuint(count) || repeat(count, uint32be)
```

`VALUE_DISPATCH_EXACT` — The first octet selects exactly one production in the
table below. Payload bytes are consumed only by that selected production.

`TAG_TABLE_EXHAUSTIVE` — The following 15 tags are the entire governed tag
space. Every other initial octet is unknown and is rejected.

| Value production |    Tag | Payload layout                                 |
| ---------------- | -----: | ---------------------------------------------- |
| `null`           | `0x00` | unit; no payload                               |
| `false`          | `0x01` | unit; no payload                               |
| `true`           | `0x02` | unit; no payload                               |
| `integer`        | `0x03` | zigzag varuint                                 |
| `float64`        | `0x04` | fixed-width Float64                            |
| `string`         | `0x05` | varuint byte length, then UTF-8 bytes          |
| `bytes`          | `0x06` | varuint byte length, then uninterpreted octets |
| `array`          | `0x07` | varuint count, then values                     |
| `object`         | `0x08` | varuint count, then string-key/value pairs     |
| `map`            | `0x09` | varuint count, then key/value pairs            |
| `set`            | `0x0a` | varuint count, then values                     |
| `float32-array`  | `0x0b` | varuint count, then Float32 elements           |
| `float64-array`  | `0x0c` | varuint count, then Float64 elements           |
| `int32-array`    | `0x0d` | varuint count, then signed 32-bit elements     |
| `uint32-array`   | `0x0e` | varuint count, then unsigned 32-bit elements   |

## Unsigned and signed integers

`VARUINT_MINIMAL` — A varuint is little-endian base-128 (LEB128-style). Each
octet contributes its low seven bits. Bit `0x80` means that another group
follows. For groups `g[0]` through `g[k-1]`, the value is:

```text
sum(g[i] * 2^(7*i), i = 0 .. k-1)
```

The last group has no continuation bit. Zero is the single octet `0x00`. A
multi-octet encoding whose last seven-bit group is zero is non-minimal and is
rejected. Thus every governed unsigned value has exactly one varuint encoding.

`VARUINT_RANGE` — A varuint contains at most nine octets and its decoded value
is at most `18014398509481983` (`2^54 - 1`). These are distinct validation
phases. A continuation requiring a tenth octet is the machine phase
`VARUINT_RANGE_OCTETS`. After a permitted terminator and the minimality check, a
decoded value above the maximum is the machine phase `VARUINT_RANGE_VALUE`.
Either phase rejects with the `VARUINT_RANGE` category.

`ZIGZAG_SAFE_INTEGER` — Integer source values are exactly the mathematical
integers in `[-9007199254740991, 9007199254740991]`. Zigzag maps them to
varuints by:

```text
zigzag(n) = 2*n       when n >= 0
zigzag(n) = -2*n - 1  when n < 0
```

Decoding reverses the mapping: an even `z` is `z/2`, and an odd `z` is
`-(z+1)/2`. The integer production first completes its `VARUINT` stage and then
checks the decoded result at the `INTEGER_RANGE` stage. A result outside the
safe-integer interval is rejected as `INTEGER_RANGE`.

`LENGTHS_COUNTS_VARUINT` — Every byte length and element or entry count in the
recursive production uses the same minimal varuint production. A length counts
payload octets; a count counts logical array elements, object entries, map
entries, set elements, or typed-array elements as named by its production.
Zero is a valid length or count and uses the single varuint octet `00`.
Consequently, the empty string encodes as `05 00`; empty array, object, map, and
set values encode as `07 00`, `08 00`, `09 00`, and `0a 00`; and every
zero-element typed array consists of its tag followed by `00`.

`NON_MINIMAL_REJECT` — Non-minimal varuints are forbidden in every position,
including integer payloads, lengths, and counts.

## Scalar numbers

`BIG_ENDIAN_NUMERICS` — All fixed-width scalar and typed numeric payloads use
network byte order (most-significant octet first). Float32 and Float64 use their
IEEE 754 binary interchange encodings. Int32 is signed two’s complement.
Uint32 is unsigned binary.

`INTEGER_BEFORE_FLOAT` — On encoding, every finite integral scalar in the safe
integer interval uses tag `0x03`, never tag `0x04`. Other finite scalar numbers
use tag `0x04`. On governed decoding, a Float64 that denotes a safe integer is
rejected as `FLOAT_SAFE_INTEGRAL`.

`FLOAT_FINITE` — Scalar Float64 source values and decoded scalar Float64
payloads must be finite. NaN and either infinity are rejected.

`NEGATIVE_ZERO_NORMALIZE` — Scalar negative zero is normalized to positive
integer zero before tag selection and therefore encodes as `03 00`. A scalar
Float64 payload representing negative zero is non-canonical and is rejected.
Floating typed-array elements follow the same encode normalization and decode
rejection.

`UNSAFE_INTEGRAL_FLOAT_UNRESOLVED` — Unsafe-integral scalar Float64 decode is
`unresolved-outside-governed-corpus`. This grammar neither ratifies acceptance
nor requires rejection for a finite integral Float64 outside the safe-integer
interval. Such a byte sequence is outside this grammar’s governed corpus until
a later numbered decision resolves it. This exception does not broaden scalar
encoding: an integral source outside the safe-integer interval remains
unencodable.

## Strings and bytes

`STRING_UTF8` — A governed string is a sequence of Unicode scalar values. Its
payload is the shortest well-formed UTF-8 encoding of that sequence, preceded
by the payload’s octet length. Decoding UTF-8 is fatal: malformed, overlong,
surrogate, truncated, or out-of-range sequences are rejected as `UTF8_INVALID`.
String payload acquisition and fatal UTF-8 decoding form one validation step:
an unavailable declared string payload is therefore remapped to `UTF8_INVALID`,
whereas an unavailable declared bytes or container payload remains `TRUNCATED`.

`STRING_UNPAIRED_SURROGATE` — A source representation that exposes UTF-16 code
units must reject an unpaired high or low surrogate before encoding. Decoded
strings must likewise contain only Unicode scalar values.

`BYTES_LENGTH` — A bytes value is an immutable logical sequence of arbitrary
octets. Its varuint is the exact following payload length. The payload has no
text interpretation. A declared length exceeding the available input is
`TRUNCATED`.

## Recursive collections

`ARRAY_DENSE` — An array has exactly `count` present elements at indices zero
through `count - 1`. Holes are not values and sparse arrays are rejected.
Elements are recursively encoded in index order.

`OBJECT_PLAIN_NULL_PROTOTYPE` — An encodable object must have either the
language’s ordinary object prototype or no prototype. Class instances and
objects with any other prototype are rejected. A decoded object always has no
prototype, including when an own key is named `__proto__`; that key remains
inert data.

`OBJECT_STRING_KEYS` — Object keys are strings only. Each key uses the complete
string value production, including tag and length. A decoded non-string object
key is rejected after its associated value has been decoded.

`OBJECT_DATA_PROPERTIES` — An object encodes only its own enumerable string-keyed
data properties. Own non-enumerable string properties are ignored. Any own
symbol key is rejected. An enumerable accessor property is rejected rather than
invoked. Each retained data-property value is recursively encoded.

`MAP_ENCODED_KEY_ORDER` — Object entries and map entries are sorted in ascending
unsigned lexicographic order of each complete encoded key byte string.
Comparison examines octets left to right; if one is a prefix of the other, the
shorter byte string sorts first. Map keys may be any governed value. Object keys
remain string-only.

`SET_ENCODED_VALUE_ORDER` — Set elements are sorted by the same ascending
unsigned lexicographic comparator over each complete encoded value byte string.

`DUPLICATE_CANONICAL_REJECT` — Two adjacent sorted map/object keys with equal
complete encoded bytes are forbidden on decode. Two adjacent sorted set values
with equal complete encoded bytes are also forbidden. Encoders reject distinct
map keys or set values that collapse to equal canonical bytes. Equality is byte
equality, not source-language identity or decoded-value equality. Ordering is
strict, so equality and descending order are both rejected.

## Typed arrays

`TYPED_ARRAY_WIDTH` — A typed-array count is followed by exactly `count * width`
payload octets:

| Production      | Width | Element domain                             |
| --------------- | ----: | ------------------------------------------ |
| `float32-array` |     4 | IEEE 754 binary32, big-endian              |
| `float64-array` |     8 | IEEE 754 binary64, big-endian              |
| `int32-array`   |     4 | signed two’s-complement 32-bit, big-endian |
| `uint32-array`  |     4 | unsigned 32-bit, big-endian                |

The count is an element count, not a byte length. Insufficient payload bytes are
`TRUNCATED`.

`TYPED_ARRAY_FINITE` — Floating typed-array elements must be finite. Their
negative-zero behavior is governed by `NEGATIVE_ZERO_NORMALIZE`. Integer typed
arrays have no finite or negative-zero condition beyond their fixed signed or
unsigned 32-bit element domain.

## Source-domain rejection

`CYCLE_REJECT` — The value graph must be acyclic along the active recursive
encoding path. Re-entering an active array, object, map, or set is rejected.
Repeated references on separate completed branches are permitted and encode by
value.

`UNSUPPORTED_TYPE_REJECT` — Values outside the productions are rejected. This
includes arbitrary-precision integers, symbols and callables as values;
arbitrary buffers or views not represented by the bytes or four typed-array
productions; regular expressions; dates; and other class instances requiring an
explicit higher-level protocol codec.

## Decoder validity and resource limits

`UNKNOWN_TAG_REJECT` — An initial octet outside `0x00` through `0x0e` is
rejected as `UNKNOWN_TAG`.

`TRAILING_REJECT` — The start production consumes exactly one complete value
and all input octets. Any remaining octet is `TRAILING_BYTES`.

`RESOURCE_LIMITS` — Default limits are:

| Limit      |     Default | Accounting                                          |
| ---------- | ----------: | --------------------------------------------------- |
| `maxBytes` | `268435456` | complete encoded input or output                    |
| `maxDepth` |       `128` | root is depth 0; every recursive value child adds 1 |
| `maxItems` |   `1000000` | whole-decoder item counter described below          |

The byte-limit comparison is strictly greater-than: the byte limit is checked
against the complete input before decoding, and encoding rejects when the
complete result exceeds it. The root depth is exactly zero. The depth comparison
is also strictly greater-than and is applied upon entry to a value, so a value
exactly at `maxDepth` is allowed.

The decoder starts its item counter at zero. Entry to every `<value>` charges
exactly one item. After a collection count is read, it precharges before
decoding children: an array or set charges `count`, an object or map charges
`2 * count`, and a typed array charges `count`. Child value entries subsequently
charge their own one each. The item comparison is strictly greater-than: a
charge that makes the total exceed `maxItems` is `ITEM_LIMIT`. Counts and
lengths must also be representable as safe non-negative host sizes. Except for
the governed string remapping to `UTF8_INVALID`, an unavailable declared bytes
or container payload is `TRUNCATED`.

On encoding, only arrays, maps, and sets apply `maxItems` to their immediate
declared count. Ordinary objects do not apply an immediate property-count
limit, including after filtering to their retained enumerable data properties.
They remain subject to recursive `maxDepth` and final `maxBytes` enforcement.
Typed arrays likewise have no encode-side immediate `maxItems` check. This
encode asymmetry is normative for this profile.

## Rejection precedence

The following order is normative when more than one defect could be observed at
the same decoding stage:

1. At the outer boundary: `BYTE_LIMIT`, then decoding the `VALUE`, then
   `TRAILING_BYTES`.
2. On value entry: `DEPTH_LIMIT`, `ITEM_LIMIT`, tag-byte `TRUNCATED`, then
   `UNKNOWN_TAG`.
3. For a varuint, the machine stage order is `TRUNCATED`,
   `VARUINT_RANGE_OCTETS`, `VARUINT_NON_MINIMAL`, `VARUINT_RANGE_VALUE`.
   `VARUINT_RANGE_OCTETS` means that more than nine octets are required and
   rejects with category `VARUINT_RANGE`. Once a permitted terminator is read, a
   zero terminal group in a multi-octet form is `VARUINT_NON_MINIMAL`; this
   precedes the post-terminator value comparison.
   `VARUINT_RANGE_VALUE` means that the decoded value exceeds the maximum and
   also rejects with category `VARUINT_RANGE`.
4. For an integer payload, the machine stage order is `VARUINT`,
   `INTEGER_RANGE`. All varuint validation completes first; only then is the
   reverse-zigzag result checked against the safe-integer interval.
5. For scalar Float64: payload `TRUNCATED`, `FLOAT_NON_FINITE`,
   `FLOAT_NEGATIVE_ZERO`, then `FLOAT_SAFE_INTEGRAL`.
6. For each object or map entry: decode `KEY`; compare it with the preceding
   encoded key and reject `KEY_ORDER_OR_DUPLICATE`; decode `VALUE`; for an
   object, then require `OBJECT_KEY_TYPE`.
7. For a set, the machine stage order is `DECODE_ELEMENT`,
   `SET_ORDER_OR_DUPLICATE`, `NEXT_ELEMENT`. Decode one element, compare its
   complete bytes with the preceding element and require strictly ascending
   order, then begin the next element. An order or duplicate defect therefore
   precedes every defect observable only in a later element.
8. For a floating typed array, the machine stage order is `TRUNCATED`,
   `ELEMENT_ORDER`, `TYPED_NON_FINITE`, `TYPED_NEGATIVE_ZERO`. First require the
   complete `count * width` payload. Then inspect elements in increasing index
   order. Within the same element, reject non-finite values before negative
   zero.
9. After a complete root value: `TRAILING_BYTES`.

These stage rules are also represented by the machine grammar’s
`rejectionPrecedence` data. A later-stage defect never replaces an earlier
observable rejection.

## Canonical identity and examples

`DECODE_REENCODE_IDENTITY` — For every accepted byte string in the governed
corpus, decoding and then encoding the resulting governed value produces the
identical byte string. Strict tag selection, minimal varuints, finite-number
rules, normalization, ordering, and duplicate rejection jointly enforce this
property.

`EXAMPLES_SUBORDINATE` — The following are binding conformance examples. They
must encode to exactly the shown lowercase hexadecimal octets, but they cannot
override the grammar. Novel combinations are derived only by recursively
applying the productions and rules above; an implementation cannot use example
lookup as its definition.

| Example                                    | Governed value                   | Canonical hexadecimal          |
| ------------------------------------------ | -------------------------------- | ------------------------------ |
| `tag-null`                                 | null                             | `00`                           |
| `integer-negative-one`                     | integer −1                       | `0301`                         |
| `float64-fraction`                         | number 1.5                       | `043ff8000000000000`           |
| `string-astral`                            | string U+1F600                   | `0504f09f9880`                 |
| `object-encoded-key-order`                 | object with `aa: 1`, `z: 2`      | `080205017a0304050261610302`   |
| `float32-array-big-endian-normalized-zero` | Float32 array `[1.5, -2.25, -0]` | `0b033fc00000c010000000000000` |
