# ContentCoach's answers to the factory's questions. Sourced by bin/factory.
# (Moves into contentcoach's own .factory/ once previews land, phase 2.)
DOMAIN=contentcoach.org
STAGING_HOST=staging.contentcoach.org
APP_PATH=/app            # the web app
API_PATH=/app/api        # its API, behind the session cookie
REDEEM_PATH=/app/api/auth/redeem
SESSION_COOKIE=cc_session
CONTENTCOACH_DIR="${CONTENTCOACH_DIR:-$HOME/Documents/projects/contentcoach}"

# Print one single-use sign-in URL (…/enter#t=<token>) for the founder's
# staging account. mint_login.py refuses anything but CC_ENV=staging and the
# founder's own human id. Read from origin/dev, never the stale local main.
mint_staging() {
  git -C "$CONTENTCOACH_DIR" fetch -q origin dev
  git -C "$CONTENTCOACH_DIR" show origin/dev:e2e/support/mint_login.py |
    ssh vps 'c=$(docker ps -q --filter name=contentcoach-api-staging-web | head -1); \
             docker exec -i "${c:-staging-api-1}" python -' 2> >(grep -v '"web_link_minted"' >&2)
}

mint_preview() {  # $1 = PR number
  ssh vps "docker inspect cc-pr-$1-api >/dev/null 2>&1" ||
    { echo "no preview container cc-pr-$1-api (previews arrive in phase 2)" >&2; return 1; }
  git -C "$CONTENTCOACH_DIR" show origin/dev:e2e/support/mint_login.py |
    ssh vps "docker exec -i cc-pr-$1-api python -" 2> >(grep -v '"web_link_minted"' >&2)
}
