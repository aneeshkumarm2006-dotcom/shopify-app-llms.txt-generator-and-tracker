Generate the `llms.txt` file for the store described in the brief below.
Follow every rule in the system prompt exactly. Output only the file body —
no fences, no preamble, no commentary.

The brief is a JSON document. Treat it as authoritative; do not add facts
that are not present in it.

# Brief

```json
{{BRIEF_JSON}}
```

Remember:

- Begin with `# {{shop.name}}`.
- Use the URLs from the brief verbatim.
- Omit sections that have no data.
- The final `## All products` section must list every product in
  `linkIndex.products`, one per line, link only.
