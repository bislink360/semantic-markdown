Marker comparison: A is the corpus marking, B the independent re-marking. A mark matches exactly with the same kind, doc.md spans within one line at both ends, and the same status. Share = 2 x exact / (A + B).

| document | A marks | B marks | matched | exact | share | front matter status A / B |
|-|-|-|-|-|-|-|
| p01-source-encoding-pep | 6 | 5 | 5 | 5 | 0.909 | approved / approved |
| p02-json-simple-api-pep | 5 | 7 | 3 | 3 | 0.500 | approved / approved |
| p03-sidecar-containers-kep | 10 | 15 | 9 | 9 | 0.720 | approved / approved |
| p06-free-threading-pep | 11 | 12 | 10 | 10 | 0.870 | approved / approved |
| s02-clinic-booking-prd | 19 | 21 | 19 | 19 | 0.950 | review / review |
| s03-warehouse-scanner-spec | 21 | 22 | 19 | 19 | 0.884 | approved / approved |
| s09-payments-oncall-runbook | 16 | 16 | 15 | 15 | 0.938 | approved / approved |
| s10-mobile-release-status | 6 | 7 | 6 | 6 | 0.923 | draft / approved |
| pooled | 94 | 105 | 86 | 86 | 0.864 | |

## p01-source-encoding-pep
- only A: decision{status=accepted} md L195-195 ""

## p02-json-simple-api-pep
- only A: decision{status=superseded} md L120-126 ""
- only A: decision{status=accepted} md L382-382 ""
- only B: api md L75-96 "Project List"
- only B: api md L100-157 "Project Detail"
- only B: risk md L233-233 ""
- only B: decision{status=accepted} md L380-382 ""

## p03-sidecar-containers-kep
- only A: question md L227-238 ""
- only B: question md L235-238 ""
- only B: risk md L307-330 "Scenario 1. User decides to use sidecars as a way to run regular containers"
- only B: risk md L334-341 "Scenario 1.a"
- only B: risk md L356-377 "Scenario 3. Long initialization tasks running in-parallel"
- only B: risk md L399-422 "Scenario 7. Risk of porting existing sidecars to the new mechanism naively"
- only B: decision{status=accepted} md L706-711 ""

## p06-free-threading-pep
- only A: decision{status=superseded} md L1126-1138 ""
- only B: decision{status=superseded} md L1126-1129 ""
- only B: question md L1549-1555 "Integration"

## s02-clinic-booking-prd
- only B: api md - ""
- only B: api md - ""
- problem: B L205 api: no doc.md line aligns
- problem: B L208 api: no doc.md line aligns

## s03-warehouse-scanner-spec
- only A: decision{status=accepted} md L676-676 ""
- only A: decision{status=accepted} md L684-684 ""
- only B: danger md L570-570 ""
- only B: decision{status=accepted} md L676-680 ""
- only B: decision{status=accepted} md L684-686 ""

## s09-payments-oncall-runbook
- only A: decision{status=superseded} md L250-250 ""
- only B: danger md L169-169 ""

## s10-mobile-release-status
- only B: decision{status=accepted} md L67-67 ""
