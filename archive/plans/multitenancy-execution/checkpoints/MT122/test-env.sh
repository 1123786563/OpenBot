# MT122 seven-variable test environment (dedicated container mt122-impl-pg @ 127.0.0.1:55567).
# Test-only credentials; database names carry the brief's w14e token.
export TEST_DATABASE_URL=postgres://postgres:mt122@127.0.0.1:55567/openbot_enterprise_w14e
export ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:mt122@127.0.0.1:55567/openbot_enterprise_w14e
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_w14e_dir:entpw.dir01@127.0.0.1:55567/openbot_enterprise_w14e?options=-c%20role%3Dob_ent_directory
export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_w14e_data:entpw.data01@127.0.0.1:55567/openbot_enterprise_w14e?options=-c%20role%3Dob_ent_data
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_w14e_opr:entpw.operator01@127.0.0.1:55567/openbot_enterprise_w14e?options=-c%20role%3Dob_ent_operator
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt122@127.0.0.1:55567/openbot_enterprise_w14e_assigned"
export KB_TEST_DATABASE_URL=postgres://ent_w14e_kb:entpw.kb01@127.0.0.1:55567/openbot_kb_w14e
