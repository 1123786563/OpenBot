# MT123 seven-variable test environment (dedicated container mt123-impl-pg @ 127.0.0.1:55584).
# Test-only credentials; database names carry the brief's w15d token.
export TEST_DATABASE_URL=postgres://postgres:mt123@127.0.0.1:55584/openbot_enterprise_w15d_test
export ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:mt123@127.0.0.1:55584/openbot_enterprise_w15d_test
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_w15d_dir:entpw.dir01@127.0.0.1:55584/openbot_enterprise_w15d_test?options=-c%20role%3Dob_ent_directory
export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_w15d_data:entpw.data01@127.0.0.1:55584/openbot_enterprise_w15d_test?options=-c%20role%3Dob_ent_data
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_w15d_opr:entpw.operator01@127.0.0.1:55584/openbot_enterprise_w15d_test?options=-c%20role%3Dob_ent_operator
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt123@127.0.0.1:55584/openbot_enterprise_w15d_test_assigned"
export KB_TEST_DATABASE_URL=postgres://ent_w15d_kb:entpw.kb01@127.0.0.1:55584/openbot_kb_w15d_test
