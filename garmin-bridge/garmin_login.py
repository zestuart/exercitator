"""One-time interactive Garmin Connect login to mint the garth OAuth token.

This CANNOT run headless (Garmin requires email + password + MFA), so run it once
on a trusted machine, then copy the resulting token directory into the bridge's
mounted volume. Your password is never written to disk — only the refreshable
OAuth token is stored.

    python3 garmin_login.py                       # writes to ~/.garminconnect
    GARMIN_TOKENSTORE=./token python3 garmin_login.py   # custom dir

Deploy: copy the token dir into the `garmin-token-state` volume on Cogitator at
the path the bridge reads (GARMIN_TOKENSTORE, default /tokens). Re-run this and
re-copy if the bridge starts returning `garmin_reauth_required`.
"""

import getpass
import os
import sys

from garminconnect import Garmin

TOKENSTORE = os.environ.get("GARMIN_TOKENSTORE", os.path.expanduser("~/.garminconnect"))


def main() -> int:
    print("Garmin Connect — one-time login (token cached, password not stored)")
    email = input("  email: ").strip()
    password = getpass.getpass("  password: ")
    if not email or not password:
        print("error: email and password required", file=sys.stderr)
        return 1

    g = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("  MFA code: ").strip(),
    )
    g.login(TOKENSTORE)

    try:
        who = g.get_full_name()
    except Exception:  # noqa: BLE001
        who = "(profile call failed, but login succeeded)"
    print(f"OK — logged in as {who}")
    print(f"token cached at {TOKENSTORE}  (keep this directory private, chmod 700)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
