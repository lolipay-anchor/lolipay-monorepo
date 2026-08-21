#!/usr/bin/env python3
import sys, re

PLACEHOLDER = re.compile(
    r"your[_-]?|example|sample|dummy|placeholder|changeme|<[^>]+>|xxxx|test[_-]?key|redacted|\.\.\.",
    re.IGNORECASE,
)

PATTERNS = [
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----"), "private key block"),
    (re.compile(r"\bS[A-Z2-7]{55}\b"), "Stellar secret seed"),
    (re.compile(r"\b0x[a-fA-F0-9]{64}\b"), "raw hex private key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"), "Google API key"),
    (re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"), "Slack token"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"), "generic sk- key"),
    (re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"), "GitHub token"),
    (re.compile(r"(?i)(secret|private[_-]?key|seed|mnemonic|api[_-]?key|apikey|access[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*['\"][^'\"\n]{8,}['\"]"), "hardcoded credential"),
]

def main():
    text = sys.stdin.read()
    hits = []
    for line in text.splitlines():
        body = line[1:] if line.startswith("+") else line
        for pat, label in PATTERNS:
            m = pat.search(body)
            if m and not PLACEHOLDER.search(m.group(0)):
                hits.append(label)
                break
    if hits:
        sys.stderr.write("\nCOMMIT REJECTED - a possible secret was detected in the staged changes:\n")
        for h in sorted(set(hits)):
            sys.stderr.write("   - " + h + "\n")
        sys.stderr.write("\nMove the secret into .env (gitignored) and reference it through an env var.\n"
                         "If this is genuinely a false positive: git commit --no-verify\n\n")
        sys.exit(1)
    sys.exit(0)

if __name__ == "__main__":
    main()
