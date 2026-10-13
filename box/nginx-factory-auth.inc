# factory single sign-in: let a request through with the dashboard's cookie
# (factory_session, set at factory.contentcoach.org) OR the factory password.
# If the dashboard is down the cookie check answers 401 and the password still
# works: previews never depend on the dashboard being up.
satisfy any;
auth_basic "factory";
auth_basic_user_file /opt/factory/htpasswd;
auth_request /_factory_auth;
location = /_factory_auth {
    internal;
    auth_basic off;
    auth_request off;
    proxy_pass http://127.0.0.1:19200/auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
    proxy_connect_timeout 2s;
    proxy_read_timeout 3s;
    proxy_intercept_errors on;
    error_page 500 502 503 504 =401 /_factory_auth_down;
}
location = /_factory_auth_down {
    internal;
    auth_basic off;
    auth_request off;
    return 401;
}
