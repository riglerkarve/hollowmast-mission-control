# Why mail from hollowmast.com goes to spam — and it is not a filter

Backlog **M48** says of the first message from `GDPR@hollowmast.com`: *"a filter, not a
DNS fix."* **Measured 19 August 2026, that is the wrong way round.** There are two real
DNS problems, and a filter would hide both while leaving them in place for everyone else.

---

## What the domain actually publishes

Queried through Google's resolver, because Windows `nslookup` returned ambiguous empty
strings for the same records:

| Record | State |
|---|---|
| **SPF** | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| **DKIM** (`cf2024-1` selector) | present, RSA key published |
| **DMARC** (`_dmarc.hollowmast.com`) | **NXDOMAIN — no record exists** |

---

## Problem 1 — the SPF record does not cover whatever is sending

This is the likely cause and it is specific.

**Cloudflare Email Routing only forwards. It does not send.** So when a message goes
*out* as `GDPR@hollowmast.com`, something else is sending it — almost certainly Gmail's
"send mail as" using your own account.

The SPF record authorises exactly one thing: `_spf.mx.cloudflare.net`. **It does not
include Google.** So a message sent through Gmail as that address is being sent by a
server the domain does not authorise, and the receiving side sees an SPF failure on a
brand-new domain. That is close to a worst case for a first message.

**The fix, if you send via Gmail:**

```
v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all
```

**Confirm before changing it.** If you actually send through something else, the include
needs to be that provider's, not Google's. The question to answer first is simply: *when
you sent that test message, what did you send it from?*

---

## Problem 2 — there is no DMARC record at all

`_dmarc.hollowmast.com` does not exist. Every domain that sends mail should publish one,
and its absence removes a signal receivers actively look for. Gmail in particular has
tightened on this since 2024.

**Start at `p=none`**, which asks for no enforcement and only requests reports. It cannot
break delivery, which is exactly why it is the right first step:

```
Name:  _dmarc
Type:  TXT
Value: v=DMARC1; p=none; rua=mailto:dmarc@hollowmast.com
```

`p=none` means *"tell me what is happening, do not reject anything."* Once the reports
show only your own senders passing, `p=quarantine` becomes a considered next step rather
than a gamble. **Do not start at `p=reject`** — on a domain whose sending paths are not
yet confirmed, that rejects your own mail.

You will need a `dmarc@hollowmast.com` route in Cloudflare Email Routing to receive the
reports, or point `rua` at an address that already works.

---

## Why this matters more than one message landing in spam

**`GDPR@hollowmast.com` is a published legal contact.** It is on the privacy page as the
address people use to exercise data rights. A request that silently lands in spam is a
statutory deadline running against you while you cannot see the clock.

**`printprofit@hollowmast.com` will send to customers.** Order confirmations and support
replies from a domain that fails SPF have a poor chance of arriving.

**And a filter fixes neither.** A Gmail filter marks *your own inbox* as trusting the
address. It does nothing for the person you are writing to, which is the direction that
actually matters here.

---

## What to do, in order

1. **Answer the question**: what sends as `GDPR@hollowmast.com`? Gmail, or something else?
2. **Fix the SPF include** to match that answer. One DNS record, in Cloudflare.
3. **Add the DMARC record at `p=none`.** One DNS record. Cannot break anything.
4. **Send another test** to a Gmail address you can check, and look at *"Show original"* —
   it prints SPF, DKIM and DMARC results in plain words. That is the verification, not
   whether it landed in the inbox once.
5. **Keep the filter if you like** — but as convenience, not as the fix.

---

*All records queried 19 August 2026 via `dns.google/resolve`. DNS is cached, so allow for
propagation after any change, and re-check with the same method rather than by eye.*
