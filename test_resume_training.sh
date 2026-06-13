#!/bin/bash
# ==============================================================================
# Test Suite: Continue Training & Transfer Learning
# ==============================================================================
# Tests the resume_from_job API feature using job #8 as the source.
#
# Tests:
#   1. GET /api/ai/training-jobs/8 — verify job 8 data is returned
#   2. POST continue training — same dataset, same model, resume_from_job=8
#   3. POST transfer learning — same model, resume_from_job=8
#   4. POST model mismatch — different model_family, expect 400
#   5. POST non-existent source — resume_from_job=9999, expect 400
#   6. POST incomplete source — resume from a failed job, expect 400
#   7. Verify checkpoint path was stored in new job's config_json
# ==============================================================================


BASE="http://localhost:1111/api"
TOKEN="3ac274f6bd3e459c7ecc13e5774f622c698b08288f221e0b689822abbdfe8b61"
AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"
SOURCE_JOB=8
PASS=0
FAIL=0
CLEANUP_IDS=()

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[1;33m'
nc='\033[0m'

pass() { echo -e "  ${green}✓ PASS${nc}: $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${red}✗ FAIL${nc}: $1"; FAIL=$((FAIL+1)); }
info() { echo -e "  ${yellow}→${nc} $1"; }

echo ""
echo "============================================================"
echo "  Continue Training & Transfer Learning — Test Suite"
echo "============================================================"
echo ""

# ---------- Test 1: Verify source job exists and is completed ----------
echo "▸ Test 1: GET source job #$SOURCE_JOB"
RESP=$(curl -s -w "\n%{http_code}" "$BASE/ai/training-jobs/$SOURCE_JOB" -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "200" ]; then
    STATUS=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
    MODEL=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model_family',''))" 2>/dev/null)
    DATASET=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('dataset_id',''))" 2>/dev/null)
    CONFIG=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('config_json',''))" 2>/dev/null)
    ARTIFACT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('artifact_directory',''))" 2>/dev/null)
    
    if [ "$STATUS" = "completed" ]; then
        pass "Job #$SOURCE_JOB is completed"
        info "model=$MODEL, dataset=$DATASET, artifact=$ARTIFACT"
    else
        fail "Job #$SOURCE_JOB status='$STATUS' (expected 'completed')"
    fi
    
    if [ -n "$CONFIG" ]; then
        pass "config_json is present"
        info "config: ${CONFIG:0:120}..."
    else
        fail "config_json is empty"
    fi
else
    fail "HTTP $HTTP getting job #$SOURCE_JOB"
fi

# ---------- Test 2: Continue Training (same dataset, same model) ----------
echo ""
echo "▸ Test 2: Continue Training — POST with resume_from_job=$SOURCE_JOB"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"$MODEL\",
        \"run_name\": \"test_continue_from_${SOURCE_JOB}\",
        \"resume_from_job\": $SOURCE_JOB,
        \"config\": {
            \"epochs\": 600,
            \"learning_rate\": 0.0001,
            \"batch_size\": 4,
            \"optimizer\": \"adamw\",
            \"scheduler\": \"cosine\",
            \"checkpoint_interval\": 10,
            \"selected_input_params\": [\"Rotation Speed UDF\"],
            \"selected_target_fields\": [\"Velocity Magnitude (m/s)\"]
        }
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "200" ]; then
    JOB_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    MSG=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)
    CKPT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('resume_from_checkpoint',''))" 2>/dev/null)
    
    if echo "$MSG" | grep -qi "checkpoint"; then
        pass "Continue training job created (id=$JOB_ID)"
        info "message: $MSG"
    else
        fail "Job created but message doesn't mention checkpoint: $MSG"
    fi
    
    if [ -n "$CKPT" ] && [ "$CKPT" != "None" ] && [ "$CKPT" != "null" ]; then
        pass "Checkpoint path returned: $CKPT"
    else
        fail "No checkpoint path in response (got: $CKPT)"
    fi
    
    CLEANUP_IDS+=("$JOB_ID")
    CONTINUE_JOB_ID=$JOB_ID
else
    fail "HTTP $HTTP creating continue training job"
    info "Response: $BODY"
fi

# ---------- Test 3: Verify continue job has resume_from_checkpoint in config ----------
echo ""
echo "▸ Test 3: Verify continue job config has resume_from_checkpoint"
if [ -n "$CONTINUE_JOB_ID" ]; then
    RESP=$(curl -s "$BASE/ai/training-jobs/$CONTINUE_JOB_ID" -H "$AUTH")
    JOB_CONFIG=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('config_json',''))" 2>/dev/null)
    
    if echo "$JOB_CONFIG" | grep -q "resume_from_checkpoint"; then
        pass "config_json contains resume_from_checkpoint"
        CKPT_PATH=$(echo "$JOB_CONFIG" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('resume_from_checkpoint',''))" 2>/dev/null)
        info "checkpoint path: $CKPT_PATH"
        
        # Verify the checkpoint file exists
        if [ -f "$CKPT_PATH" ] || [ -L "$CKPT_PATH" ]; then
            pass "Checkpoint file exists on disk"
        else
            fail "Checkpoint file NOT found at: $CKPT_PATH"
        fi
    else
        fail "config_json missing resume_from_checkpoint"
        info "config: $JOB_CONFIG"
    fi
    
    # Check the DB column too
    DB_CKPT=$(sudo sqlite3 /opt/mstar_queue/mstar_queue.db "SELECT resume_from_checkpoint FROM ai_training_jobs WHERE id=$CONTINUE_JOB_ID;" 2>/dev/null)
    if [ -n "$DB_CKPT" ]; then
        pass "resume_from_checkpoint column set in DB"
        info "DB value: $DB_CKPT"
    else
        fail "resume_from_checkpoint column is empty in DB"
    fi
else
    fail "No continue job ID — skipping config check"
fi

# ---------- Test 4: Transfer Learning (same model, different run name) ----------
echo ""
echo "▸ Test 4: Transfer Learning — POST with resume_from_job=$SOURCE_JOB"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"$MODEL\",
        \"run_name\": \"test_transfer_from_${SOURCE_JOB}\",
        \"resume_from_job\": $SOURCE_JOB,
        \"config\": {
            \"epochs\": 200,
            \"learning_rate\": 0.0005,
            \"batch_size\": 4,
            \"optimizer\": \"adamw\",
            \"scheduler\": \"reduce_on_plateau\"
        }
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "200" ]; then
    TRANSFER_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    pass "Transfer learning job created (id=$TRANSFER_ID)"
    CLEANUP_IDS+=("$TRANSFER_ID")
else
    fail "HTTP $HTTP creating transfer learning job"
    info "Response: $BODY"
fi

# ---------- Test 5: Model Family Mismatch — expect 400 ----------
echo ""
echo "▸ Test 5: Model family mismatch — should return 400"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"mlp\",
        \"run_name\": \"test_mismatch\",
        \"resume_from_job\": $SOURCE_JOB
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "400" ]; then
    ERR=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    if echo "$ERR" | grep -qi "mismatch"; then
        pass "Model mismatch correctly rejected with 400"
        info "Error: $ERR"
    else
        fail "Got 400 but error message doesn't mention mismatch: $ERR"
    fi
else
    fail "Expected 400 for model mismatch, got HTTP $HTTP"
    info "Response: $BODY"
fi

# ---------- Test 6: Non-existent source job — expect 400 ----------
echo ""
echo "▸ Test 6: Non-existent source job — should return 400"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"unet\",
        \"run_name\": \"test_nonexistent\",
        \"resume_from_job\": 9999
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "400" ]; then
    ERR=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    pass "Non-existent source correctly rejected with 400"
    info "Error: $ERR"
else
    fail "Expected 400 for non-existent source, got HTTP $HTTP"
    info "Response: $BODY"
fi

# ---------- Test 7: Incomplete source job (failed) — expect 400 ----------
echo ""
echo "▸ Test 7: Failed source job — should return 400"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"unet\",
        \"run_name\": \"test_from_failed\",
        \"resume_from_job\": 4
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "400" ]; then
    ERR=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    if echo "$ERR" | grep -qi "not completed"; then
        pass "Failed source correctly rejected with 400"
        info "Error: $ERR"
    else
        fail "Got 400 but unexpected error: $ERR"
    fi
else
    fail "Expected 400 for failed source, got HTTP $HTTP"
    info "Response: $BODY"
fi

# ---------- Test 8: Normal job without resume (backward compat) ----------
echo ""
echo "▸ Test 8: Normal job without resume_from_job (backward compatibility)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/ai/training-jobs" \
    -H "$AUTH" -H "$CT" \
    -d "{
        \"dataset_id\": $DATASET,
        \"model_family\": \"unet\",
        \"run_name\": \"test_normal_no_resume\",
        \"config\": {\"epochs\": 10}
    }")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

if [ "$HTTP" = "200" ]; then
    NORMAL_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    MSG=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)
    CKPT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('resume_from_checkpoint') or 'null')" 2>/dev/null)
    
    if [ "$CKPT" = "null" ] || [ "$CKPT" = "None" ]; then
        pass "Normal job created without checkpoint (id=$NORMAL_ID)"
        info "message: $MSG"
    else
        fail "Normal job unexpectedly has checkpoint: $CKPT"
    fi
    CLEANUP_IDS+=("$NORMAL_ID")
else
    fail "HTTP $HTTP creating normal job"
    info "Response: $BODY"
fi

# ---------- Cleanup: Cancel test jobs ----------
echo ""
echo "▸ Cleanup: Cancelling test jobs..."
for JID in "${CLEANUP_IDS[@]}"; do
    RESP=$(curl -s -X POST "$BASE/ai/training-jobs/$JID/cancel" -H "$AUTH" -H "$CT" -d '{}')
    info "Cancelled job #$JID"
done

# ---------- Summary ----------
TOTAL=$((PASS + FAIL))
echo ""
echo "============================================================"
if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${green}ALL $TOTAL TESTS PASSED${nc}"
else
    echo -e "  ${red}$FAIL FAILED${nc} / $TOTAL total ($PASS passed)"
fi
echo "============================================================"
echo ""

exit $FAIL
