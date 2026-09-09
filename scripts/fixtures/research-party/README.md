# Research wire snapshots

Exact synthetic Backend fixtures, copied once for the Feed's required parser
and production-browser checks. They are test data, not real research results.
No bearer, credential or user data is included. Missing fixtures are a test
failure: no sibling checkout, optional skip or synchronization pipeline.

Source repository: `Glera/swipe-backend`.
Original directory: `tests/fixtures/` (same filenames below).
Source checkpoint: `4edb3274726c8081a036c1c766399b23dbff51dd`
(verified local Backend commit; not yet a merged or live release).

The source HTTP + PostgreSQL tests compare the result and choice responses to
these exact goldens. Feed additionally exercises synthetic 7-card and hostile
literal-text variants derived in its test harness, never production fallbacks.

| Filename | SHA-256 of exact file bytes |
| --- | --- |
| research-party-choice-command-v1.golden.json | `4ff5df4b5a483762b427a66392baf8edc26c618200da3212c9233ef20cf5f7d3` |
| research-party-choice-receipt-v1.golden.json | `0bc7fb37ce03ab95b6ee52a0efe78435b38721bd60502f97f86c38f6c434ea78` |
| research-party-choice-response-v1.golden.json | `f52a41cc3c489169f2a25cff659ba04bcad347fd6ef4c52b13cbc60d3ae79846` |
| research-party-normalized-pack-v1.golden.json | `cfa7ef4da4acf0a6245979ffdccd670722a49a26200f2f0896065ea2a23e25ee` |
| research-party-radar-v1.golden.json | `8a1c920bb71bee44c45827ea4cacf9871a926610f98ea32248e5a11edd50b29e` |
| research-party-result-v1.golden.json | `04d65f1c8b29fd4d36e46ef59f7d39ef8d2af11ab1d90b446d28eb823ae11abd` |
| research-party-shortlist-context-v1.json | `ee7401fb3fa0097cde985b4750e0647f3070685c5f7e0618d2edcb987ec42c96` |
| research-party-shortlist-v1.golden.json | `fc1b31f6bbaa0e4d3cea5682f89fc106c5de5624aa71bc7902fec8a114b0f087` |
| research-party-phone-capability-v1.golden.json | `ac6a9effa9ef85b1b0467cc8b882ca0e243d40f44784a16bef298034f5061afe` |
| research-party-phone-accepted-intake-v1.golden.json | `f92402a61ff8a69e2819bae95ad1055c5a1dc3629b15108bfcf1b05d1eb73c03` |
| research-party-phone-intake-list-v1.golden.json | `125b9ad235a218eae29ea2988ccc3ae69d57e0e06a47cbf4cf16d8d3b0d66091` |
