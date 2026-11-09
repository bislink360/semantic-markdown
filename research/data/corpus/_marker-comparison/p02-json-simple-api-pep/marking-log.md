# Marking log: p02-json-simple-api-pep

Marker: ai-marker-1. Status mapping: md line 3 "Status: Final." mapped to `approved` (a Final PEP is accepted and in force). Line 5 calls the PEP "a historical document" but the status line is Final, so the status follows the status line.

L80: `:::api{method=GET path="/"} Project List` — "#### Project List … The root URL `/` for this PEP (which represents the base URL) will be a JSON encoded dictionary which has a two keys (method from "Client->>Server: GET /simple/" and `requests.get("https://pypi.org/simple/"…`)"
L107: `:::api{method=GET path="/<project>/"} Project Detail` — "#### Project Detail … The format of this URL is `/<project>/` … This URL must respond with a JSON encoded dictionary that has three keys (method as above)"
L226: `:::warning` — "**Important:** This PEP **does** require that if the meta version `latest` is being used, the server **MUST** respond with the content type for the actual version"
L244: `:::risk{likelihood=low}` — "This is technically a backwards incompatible change, however in practice pip has been enforcing this requirement so the risks for actual breakages is low."
L335: `:::question` — "this PEP defers making a decision about how exactly to represent this inside of PEP 458 metadata. Until that decision is made, TUF target paths should name an explicit version and format"
L395: `:::decision{status=accepted}` — "Status: Accepted. … This PEP renames the metadata provided by PEP 658"
L415: `{agent=skip}` — "## History"
