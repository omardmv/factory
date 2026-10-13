# __PROJECT__'s answers to the factory's questions (bin/factory, bin/factory-box).
DOMAIN=__DOMAIN__            # previews at <feature>-pr<N>.__DOMAIN__ (needs a proxied "*" DNS record)
PREFIX=__PREFIX__            # containers __PREFIX__-pr-<N>-*, DBs __PREFIX___pr_<N>, network factory-__PREFIX__
REPO=__REPO__
APP_PATH=/                   # where the app lives on the preview host
HEALTH_PATH=/                # answers 200 once the preview is up
LOGIN_PATH=/

# --- data source (optional: delete these three for a project with no database)
# SOURCE_DB_CONTAINER=__PREFIX__-staging-db-1
# SOURCE_DB_NAME=app
# SOURCE_MEDIA_VOLUME=__PREFIX___staging_media

# build the images for the checkout in $1; set IMAGE_API and IMAGE_WEB
build_images() {  # $1 checkout dir, $2 tag
  docker build -q -t "factory/__PREFIX__-app:$2" "$1" >/dev/null
  IMAGE_API="factory/__PREFIX__-app:$2"; IMAGE_WEB="$IMAGE_API"
}

# run the project's e2e suite against $3 (results in $1/$E2E_OUT_DIR)
run_e2e() {  # $1 checkout, $2 PR, $3 app URL
  (cd "$1" && npm ci --silent && APP_URL="$3" npx e2e run --video on --trace on)
}
E2E_OUT_DIR=.e2e
