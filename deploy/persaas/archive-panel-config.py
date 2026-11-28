#!/usr/bin/env python3
"""Compatibility entry: archive only container env files."""
from pathlib import Path
import subprocess
import sys

if __name__ == '__main__':
    subprocess.run([sys.executable, str(Path(__file__).with_name('middleware-config.py')), 'push'], check=True)
