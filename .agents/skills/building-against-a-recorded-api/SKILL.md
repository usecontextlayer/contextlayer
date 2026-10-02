---
name: building-against-a-recorded-api
description: Use when writing or testing a client against someone else's API — an MCP server, a sync connector, any integration — and you are about to hand-write a fake, a stub, or a fixture. Also use when an existing integration's tests pass but production breaks, or when deciding whether a defensive branch is earning its place.
---

# Building against a recorded API

**A hand-written fake encodes what you imagine the API does. Tests against it prove your code agrees with your imagination.**

That is not a hypothetical failure mode. In the package this skill came out of, four real defects shipped or nearly shipped. The 22-test suite, green throughout, caught none of them. Each was found by reading code, by an outside reviewer, or by production.

Worse: the one defect a fixture *should* have caught was missed because the fixture was **invented rather than copied** — someone typed a plausible-looking UUID (in fact the RFC 4122 spec's own example) where a real id belonged. Real ids from that system are not RFC-4122. Every test passed; every production write failed.

The fix is not better imagination. It is to stop imagining.

## The one rule

**Record what the API actually says. Never write a response by hand.**

Everything else follows from that.

## Why fakes fail in one direction

A fake that is *wider* than reality causes false failures — noisy, visible, quickly fixed. A fake that is **narrower** than reality is silent, and licenses you to tighten code against a world that does not exist.

Ours returned exactly the key set our schema expected. The real API decorated every response with metadata we had never seen. A one-word change — loosening a schema to strict — would have kept every test green and broken every production write. Narrowness is the dangerous direction, and hand-written fakes are always narrow, because you write down what you thought to ask for.

## What is unobserved should not be designed for

This is the sharp edge, and it cuts against instinct.

If the API has never been observed producing a condition, **do not write a branch for it**. Not a null check, not a fallback, not a "just in case" parse guard. Those branches feel like rigour; they are speculation with test coverage stapled on, and they make the code larger and the failure modes murkier.

Once you have a recording, this stops being a judgement call. "Does the API do this?" becomes a question with an answer. We deleted two production branches and their tests on exactly this basis — the recording showed every response the service returns carries a body, so the code guarding empty ones was guarding nothing.

If such a response ever does appear: record it, *then* design for it.

## Record the failures, not just the happy path

Left alone, you will record the happy path and whatever went wrong by accident. Force the rest. Deliberately provoke, at minimum:

- an unauthenticated call, and a malformed-credential call
- something that does not exist
- malformed or out-of-range input
- **an operation rejected after being accepted** — the state that most often has no handling
- an action against an object in the wrong state
- whatever permission or quota errors the API defines

Nobody imagines a real API's error text. You would not have guessed `SandboxFault.ThrowIfGuidEmpty: entityId`, and you would not have guessed that a missing sub-resource comes back as *"Input entity object cannot be null"* — a message that is actively misleading and that your code must nonetheless pass through faithfully.

## Construct every state; never discover one

Do not query the API for whatever happens to be lying around and record that. It makes the recording depend on the moment you ran it, and it fails *silently* — a quiet system yields a cassette that is simply missing states, and you will not notice.

Build each state instead: create the thing, read it, act on it, read it again. Chain the scenarios so a lifecycle is recorded **as a lifecycle**, each step using what the previous one produced. That is also how you capture the interesting middles — the in-flight state, the just-executed state — which a snapshot of a settled system never contains.

## Record the request, not just the response

Easy to skip, and it costs you the ability to answer questions like "did the service honour the id we sent, or assign its own?" Without the request, that is inference. With it, and with consistent normalization, it is evidence.

## Capture and normalize in one pass; never hand-edit a fixture

Volatile values — ids, timestamps, etags, hostnames — are replaced **as they are recorded**, so nothing unnormalized ever reaches disk. Give ids you know the meaning of a semantic placeholder and everything else a stable positional one, so the *relationships* between values survive.

Then hold the line: **a fixture is never edited by hand.** To change one, change the recorder and re-run. The recorder is checked in alongside the fixtures precisely so this is possible. A hand-edited fixture is a hand-written fake wearing a costume, and it will drift back toward imagination one small edit at a time.

Two gates before anything is written: **no secrets**, and **nothing unnormalized**. Fail the run rather than write a bad fixture.

## The outcome to aim for

The replay should make an invented response **impossible to ask for**, not merely discouraged. A test selects a recorded CONVERSATION by name, and every interaction within it is routed from the request the code under test actually sends — a test cannot name a response. An unknown conversation, or a request the recording does not contain, fails loudly with a message that says: if the API does this, record it — if it does not, the test should not want it.

That converts the rule from a policy someone must remember into a mechanism that enforces itself. You will know it is working when it catches *you* — ours immediately rejected an error code its author had written from memory.

Two more outcomes worth engineering for:

- **Oracles check against the wire, not against a twin.** A constant hand-copied beside the code it validates is a consistency check, not an oracle — change both and it stays green. Derive it from the recording instead.
- **Deleting speculative code becomes evidence-backed.** "Nothing in the recording does this" ends an argument that otherwise runs on taste.

## What this does not cover — and must not pretend to

- **Timing.** Fixtures capture shapes. They will make you *more* confident while hiding latency entirely — a recorded sequence says an operation took four polls, never how long a poll waited. Ours settled in seconds most of the time and once took half a minute, and only counting the recorded polls said so; the number a session *remembers* is worse than no number, because it survives into comments and product copy where nothing can check it. Measure it separately, from the artifact.
- **The contract on your other side.** For an MCP server, what you advertise to the calling model is a different contract from what the API tells you. Recording the API says nothing about it.
- **Faults the API cannot produce** — network interruptions, proxies, truncated responses. These are real but they are not the API's behaviour. Either do not design for them, or keep them explicitly separate and labelled so nobody mistakes them for recorded truth.

## The trap on the other side

Fidelity is not the same as coupling. Record everything; assert on what carries meaning. A test pinned to an etag or a timestamp is as broken as a too-narrow fake — just noisier about it. This is what normalization is for.

## Sequencing

Record → build → test. The recording comes first because it is the thing you are building *against*.

Retrofitting an existing integration inverts this, and that is fine — record, then diff the recording against whatever your fake has been claiming. Expect to find that the fake was narrower than reality, and expect at least one assertion you wrote from memory to be wrong.
