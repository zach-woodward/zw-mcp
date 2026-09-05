# Blog posts

Source for published writing about this project.

## not-a-magic-box.html

**Published at:** https://claude.ai/code/artifact/3ea955af-ab32-440d-bef0-893d5fb3dd87

Written August 2026. The argument: MCP is a thin, well-specified envelope around
integration work you were going to do anyway, and building your own is how you
find out what is actually in it.

Draws on this build for its specifics -- the two-tier tool design, six places the
vendor documentation disagreed with the live API, the difference between a
specific 403 and a bare one, and the discovery that hosted connectors need a
full OAuth authorization server rather than a bearer header.

### Updating it

The artifact was originally published from a scratchpad path, which is why the
source was lost once that directory was cleared. It now lives here instead.

**Publishing this file without passing the existing URL creates a SECOND
artifact** rather than updating the live one -- a new file path claims a new URL.
To update the published post, pass the URL above explicitly:

```
Artifact(file_path: "docs/blog/not-a-magic-box.html",
         url: "https://claude.ai/code/artifact/3ea955af-ab32-440d-bef0-893d5fb3dd87")
```

### Editorial notes

- No customer data. The platform is described generically, counterparty names
  from the demo repository are omitted, and there are no account identifiers,
  hostnames or tokens anywhere in the file.
- Both mistakes made during the build are kept in deliberately: misreading
  `consent_required` as an entitlement failure, and hunting for a connector
  header field that never existed. A post that is only wins reads like marketing.
- Design: cool instrument neutrals with a single teal signal, Bricolage Grotesque
  over Newsreader, JetBrains Mono for the request logs. The logs are treated as
  hero material because the 404-to-200 transition is the story.
- Light and dark themes are both defined at token level on bare `:root`, so the
  page holds up in either.
