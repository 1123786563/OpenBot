#!/bin/bash
# MT042 seven-variable env (brief: 同 MT022 brief 七变量 env，库名 w14b).
# Container mt042-impl-pg (pgvector/pgvector:pg16) @ 127.0.0.1:55564, loopback only.
# Variables (7): TEST_DATABASE_URL, ENTERPRISE_TEST_SETUP_DATABASE_URL,
# ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL, MT003_ASSIGNED_TEST_DATABASE_URL,
# KB_TEST_DATABASE_URL. Missing env => tests explicitly skip, never a dev-database fallback.
export TEST_DATABASE_URL=postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b
export ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_w14b_directory:entpw.dir01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_directory
export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_w14b_data:entpw.data01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_data
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_w14b_operator:entpw.operator01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_operator
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b_assigned"
export KB_TEST_DATABASE_URL="postgres://ent_w14b_kb:entpw.kb01@127.0.0.1:55564/openbot_kb_w14b"
