# MT074 seven-variable test environment (dedicated container w16-mt074-impl-pg @ 127.0.0.1:55596).
# Test-only credentials; database names carry the wave-16 token w16e_test.
export TEST_DATABASE_URL=postgres://postgres:mt074@127.0.0.1:55596/openbot_enterprise_w16e_test
export ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:mt074@127.0.0.1:55596/openbot_enterprise_w16e_test
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_w16e_dir:entpw.dir01@127.0.0.1:55596/openbot_enterprise_w16e_test?options=-c%20role%3Dob_ent_directory
export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_w16e_data:entpw.data01@127.0.0.1:55596/openbot_enterprise_w16e_test?options=-c%20role%3Dob_ent_data
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_w16e_opr:entpw.operator01@127.0.0.1:55596/openbot_enterprise_w16e_test?options=-c%20role%3Dob_ent_operator
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt074@127.0.0.1:55596/openbot_enterprise_w16e_test_assigned"
export KB_TEST_DATABASE_URL=postgres://ent_w16e_kb:entpw.kb01@127.0.0.1:55596/openbot_kb_w16e_test
