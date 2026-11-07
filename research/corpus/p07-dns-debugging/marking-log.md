L1-L6: front matter (title, summary, status=approved) — "Debugging DNS Resolution", "This page provides hints on diagnosing DNS problems.", "Status: published task page of the Kubernetes documentation, for Kubernetes v1.37." (a published documentation page maps to approved)
L21: :::agent — "## Note for automated tools and agents", "Note for automated tools and agents: the checks on this page that only read state ... are safe to run without asking."
L207: :::danger — "> **Warning:** Do not leave the `log` plugin enabled after you finish debugging" with stated harm "can fill the node's disk and slow down CoreDNS"
L248: :::question — "This should probably be implemented eventually. Whether and how is undecided. Until then, configure the node's resolver yourself"
L260: :::decision{status=superseded} — "To work around this limit, the node can run `dnsmasq`", and at L273 "the `dnsmasq` workaround for the `nameserver` limit in Known issues is replaced and no longer recommended"
L272: :::decision{status=accepted} — "Accepted change: the `dnsmasq` workaround ... is replaced ... Use kubelet's `--resolv-conf` flag ... instead"
L276: {agent=skip} — "## Background", "This section is kept for people who maintain older clusters and is not needed to debug a current one."
