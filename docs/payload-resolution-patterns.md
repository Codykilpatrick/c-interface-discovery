# Payload Resolution Patterns

The payload resolver attempts to identify the C struct type being passed to a registered IPC function.
Strategies are tried in order; first match wins. Confidence degrades as strategies become more indirect.

---

## Strategy 1 — Address-of local variable `HIGH`

The payload argument is `&var`, and `var` is declared in the same function body.

```c
STRUCT_TYPE msg;
ipc_send(handle, id, &msg, sizeof(STRUCT_TYPE));
//                   ^^^^
```

Resolved by: finding the local variable declaration and reading its type.

---

## Strategy 2 — Function pointer parameter `HIGH`

The payload argument is a bare identifier that matches a pointer parameter of the enclosing function.

```c
void publish_fn(HANDLE h, STRUCT_TYPE *payload) {
    ipc_send(handle, id, payload, sizeof(STRUCT_TYPE));
    //                   ^^^^^^^
}
```

Resolved by: scanning the enclosing function's parameter list for a matching pointer declarator.

---

## Strategy 2b — Local pointer variable declaration `HIGH`

The payload argument is a bare identifier declared as a typed pointer in the same function body,
including declarations with initialisers.

```c
STRUCT_TYPE *pb = &global_instance;
// or
STRUCT_TYPE *pb = (STRUCT_TYPE *) raw_passback;

ipc_send(handle, id, pb, sizeof(STRUCT_TYPE));
//                   ^^
```

Resolved by: finding the local variable's `declaration` node (including `init_declarator` forms)
and reading the declared type — the initialiser is ignored.

---

## Strategy 3 — Cast expression `MEDIUM` / `HIGH`

The payload argument is a cast expression. Several sub-cases:

### 3a — Cast wraps `&var` → `HIGH`

```c
ipc_send(handle, id, (OPAQUE_PTR) &msg, len);
//                   ^^^^^^^^^^^^^^^^
```

The inner `&var` is resolved via Strategy 1 rules; the outer cast type is discarded.
Confidence is HIGH because the concrete variable type is known.

### 3b — Cast to a known struct type → `MEDIUM`

```c
ipc_send(handle, id, (STRUCT_TYPE *) buf, len);
//                   ^^^^^^^^^^^^^^^^
```

The cast type is looked up in the struct catalog directly.

### 3c — Cast to opaque/primitive pointer, inner identifier is a typed local → `HIGH`

```c
STRUCT_TYPE *output = ...;
ipc_send(handle, id, (char *) output, len);
//                   ^^^^^^^^^^^^^^^
```

Cast type (`char`) is a primitive — resolver falls through to the inner identifier,
finds `output`'s declared type via Strategy 2b rules, and returns HIGH confidence.

### 3d — Cast to opaque pointer wrapping a field access → `HIGH`

```c
CONTAINER_TYPE *obj = (CONTAINER_TYPE *) raw;
// CONTAINER_TYPE has field: STRUCT_TYPE *field_name;

ipc_send(handle, id, (OPAQUE_PTR) obj->field_name, len);
//                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

Resolver extracts the base variable (`obj`), finds its declared type, looks up
`field_name` in that struct's field list, and resolves the field's type.

### 3e — Cast to named non-primitive not in struct catalog → `LOW`

```c
ipc_send(handle, id, (OPAQUE_TYPEDEF) obj->field, len);
```

The cast type is a meaningful name but not a struct in the catalog.
Shown with LOW confidence rather than unresolved — useful as a hint.

---

## Strategy 3f — Prior assignment tracing `HIGH` / `MEDIUM`

The payload argument is a bare identifier assigned before the call site.

```c
// Assignment to &var → HIGH
msg_data = &local_struct;
ipc_send(handle, id, len, msg_data);

// Assignment via cast → MEDIUM
msg_data = (STRUCT_TYPE *) buffer;
ipc_send(handle, id, len, msg_data);
```

Resolved by: scanning earlier statements in reverse for `lhs = rhs` where `lhs` matches
the identifier, then applying address-of or cast resolution on `rhs`.

---

## Strategy 4 — `memcpy` source tracing `MEDIUM`

The payload buffer was filled via `memcpy` from a typed source before the call.

```c
STRUCT_TYPE local_msg;
memcpy(send_buffer, &local_msg, sizeof(STRUCT_TYPE));
ipc_send(handle, id, send_buffer, sizeof(STRUCT_TYPE));
//                   ^^^^^^^^^^^
```

Resolved by: finding a prior `memcpy(dest, src, ...)` where `dest` matches the
payload argument, then applying Strategy 1 rules to `src`.

---

## Strategy 5 — Callback registration `HIGH`

A callback-registration pattern (with `callbackArgIndex` configured) resolves the
payload struct from the registered callback function's parameter types.

```c
// Callback function definition (in source or header):
void my_callback(HANDLE h, MSG_ID id, MSG_LEN len, STRUCT_TYPE *data, PASSBACK pb);
//                                                  ^^^^^^^^^^^

register_callback(handle, msg_id, my_callback, passback);
//                                ^^^^^^^^^^^
//                                callbackArgIndex = 2
```

Resolved by: looking up the callback function's definition and extracting its parameter
struct types. Confidence is HIGH when the callback is found and has a typed pointer param.

---

## Strategy 6 — Msg-ID correlation `LOW`

Fallback when no argument-level evidence is found. Uses struct types already implied
by the IPC wrapper's own parameter types (Strategy B from the message extractor).

---

## Typedef alias chasing

All struct lookups chase plain typedef aliases automatically:

```c
typedef CANONICAL_STRUCT_NAME ALIAS_NAME;
```

`ALIAS_NAME` resolves to `CANONICAL_STRUCT_NAME` through up to 4 hops, so
`resolveType("ALIAS_NAME")` returns the same struct as `resolveType("CANONICAL_STRUCT_NAME")`.
This applies in every strategy above.

---

## Confidence summary

| Confidence | Meaning |
|------------|---------|
| `high`     | Concrete variable type confirmed from declaration or address-of |
| `medium`   | Cast type or memcpy source — likely correct but one level indirect |
| `low`      | Named cast type not in catalog, or msg-ID correlation fallback |
| `unresolved` | No strategy succeeded |
