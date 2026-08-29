#!/usr/bin/env python3
"""Report banned tokens that appear inside COMMENTS, ignoring code and strings.

The rules are in comment-rules.md. A comment that cites a past run, a private
corpus, a statistic or a wall-clock number is one a new reader cannot check.

    python3 scripts/comment-residue.py $(git ls-files '*.ts')

Some hits are false positives by construction — "used to signal", a 429/403
status pair, `ceil(6/2)`. Read them; do not delete on the checker's word.
"""
import sys, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _comment_scan import comment_spans

PAT = re.compile(
    r'mx5|nexttask|gofer|/home/|~/hub|\brun[- ]\d+|\bruns \d+|TASK_\d{4}|IAR1'
    r'|\b\d+/\d+\b|p ?= ?0?\.|n ?= ?\d+|\b\d+(?:\.\d+)?%|Fisher|Wilson'
    r"|\bused to\b|\bpreviously\b|magicknumbers|VALIDATION-DEBT", re.I)

total = 0
for f in sys.argv[1:]:
    if '__fixtures__' in f:
        continue
    src = open(f, encoding='utf8').read()
    lines = src.split('\n')
    for a, b in comment_spans(src):
        for m in PAT.finditer(src[a:b]):
            n = src[:a + m.start()].count('\n') + 1
            print(f'{f}:{n}: {lines[n - 1].strip()[:120]}')
            total += 1
print(f'--- {total} in comments ---')
sys.exit(1 if total else 0)
