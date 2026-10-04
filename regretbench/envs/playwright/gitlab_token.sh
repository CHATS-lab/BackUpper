#!/usr/bin/env bash
# gitlab_token.sh <gitlab-container>
#
# Reset the root password to the one the tasks give the agent (theagentcompany)
# and mint an API token for root, printed on stdout. The token the image ships
# with has expired. Export the result as RB_GITLAB_TOKEN.
set -uo pipefail
NAME="${1:?usage: gitlab_token.sh <gitlab-container>}"
docker exec "$NAME" gitlab-rails runner "
u = User.find_by_username('root')
u.password = 'theagentcompany'; u.password_confirmation = 'theagentcompany'; u.save!
t = u.personal_access_tokens.create!(name: 'regretbench', scopes: ['api'], expires_at: 30.days.from_now)
puts t.token" | tail -1
