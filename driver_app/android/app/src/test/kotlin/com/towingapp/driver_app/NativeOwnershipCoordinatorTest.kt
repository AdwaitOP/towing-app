package com.towingapp.driver_app

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class NativeOwnershipCoordinatorTest {

    private lateinit var testPrefs: InMemorySharedPreferences
    private lateinit var fakeContext: FakeContext
    private lateinit var fakeService: DutyForegroundService

    @Before
    fun setUp() {
        testPrefs = InMemorySharedPreferences()
        fakeContext = FakeContext(testPrefs)
        fakeService = DutyForegroundService()
        DutyForegroundService.resetForTesting(fakeContext, fakeService)
        fakeService.onCreate()

        NativeOwnershipCoordinator.resetForTesting(fakeContext)
    }

    class InMemorySharedPreferences : SharedPreferences {
        val map = mutableMapOf<String, Any>()
        var commitSucceeds = true

        override fun getAll(): MutableMap<String, *> = HashMap(map)
        override fun getString(key: String?, defValue: String?): String? = map[key] as? String ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            @Suppress("UNCHECKED_CAST") (map[key] as? MutableSet<String> ?: defValues)
        override fun getInt(key: String?, defValue: Int): Int = (map[key] as? Number)?.toInt() ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = (map[key] as? Number)?.toLong() ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = (map[key] as? Number)?.toFloat() ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = map[key] as? Boolean ?: defValue
        override fun contains(key: String?): Boolean = map.containsKey(key)
        override fun edit(): SharedPreferences.Editor = Editor()
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}

        inner class Editor : SharedPreferences.Editor {
            val temp = mutableMapOf<String, Any?>()
            val toRemove = mutableSetOf<String>()
            var clearAll = false

            override fun putString(key: String?, value: String?): SharedPreferences.Editor {
                if (key != null) {
                    if (value != null) temp[key] = value else toRemove.add(key)
                }
                return this
            }
            override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor {
                if (key != null) {
                    if (values != null) temp[key] = values else toRemove.add(key)
                }
                return this
            }
            override fun putInt(key: String?, value: Int): SharedPreferences.Editor {
                if (key != null) temp[key] = value
                return this
            }
            override fun putLong(key: String?, value: Long): SharedPreferences.Editor {
                if (key != null) temp[key] = value
                return this
            }
            override fun putFloat(key: String?, value: Float): SharedPreferences.Editor {
                if (key != null) temp[key] = value
                return this
            }
            override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor {
                if (key != null) temp[key] = value
                return this
            }
            override fun remove(key: String?): SharedPreferences.Editor {
                if (key != null) toRemove.add(key)
                return this
            }
            override fun clear(): SharedPreferences.Editor {
                clearAll = true
                return this
            }
            override fun commit(): Boolean {
                if (!commitSucceeds) return false
                if (clearAll) map.clear()
                for (r in toRemove) map.remove(r)
                for ((k, v) in temp) {
                    if (v != null) map[k] = v
                }
                return true
            }
            override fun apply() {
                commit()
            }
        }
    }

    class FakeContext(val defaultPrefs: InMemorySharedPreferences) : android.content.ContextWrapper(null) {
        val prefsMap = mutableMapOf<String, InMemorySharedPreferences>()

        override fun getApplicationContext(): Context = this

        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences {
            val key = name ?: "default"
            return prefsMap.computeIfAbsent(key) {
                if (key == NativeOwnershipCoordinator.PREFS_NAME) defaultPrefs else InMemorySharedPreferences()
            }
        }

        override fun getPackageName(): String = "com.towingapp.driver_app"
    }

    class MockMethodResult : MethodChannel.Result {
        var successResult: Any? = null
        var errorCode: String? = null
        var errorMessage: String? = null
        var errorDetails: Any? = null
        var notImplementedCalled = false
        var replied = false

        override fun success(result: Any?) {
            this.successResult = result
            this.replied = true
        }

        override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
            this.errorCode = errorCode
            this.errorMessage = errorMessage
            this.errorDetails = errorDetails
            this.replied = true
        }

        override fun notImplemented() {
            this.notImplementedCalled = true
            this.replied = true
        }
    }

    private fun callCoordinator(method: String, args: Map<String, Any?>): MockMethodResult {
        val result = MockMethodResult()
        val call = MethodCall(method, args)
        NativeOwnershipCoordinator.onMethodCall(call, result)
        return result
    }

    // =========================================================================
    // Mandatory Scenario A: S1 START queued; S1 STOP completes; delayed S1 START
    // delivered. No ownerless service.
    // =========================================================================
    @Test
    fun testScenarioA_S1StartQueued_S1StopCompletes_DelayedS1StartDelivered_NoOwnerlessService() {
        DutyForegroundService.holdPendingStartsForTesting = true

        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_A")
            put("uid", "driver_A")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }

        // S1 START requested and persisted, held in queue
        val startCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_A",
            "uid" to "driver_A",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        val startRes = startCall.successResult as Map<*, *>
        assertEquals(true, startRes["success"])
        assertFalse("Service must NOT be running yet while START is queued", DutyForegroundService.isRunning)

        // S1 STOP executes and completes before START command reaches execution
        val stopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_A",
            "expectedSessionId" to "sess_A",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val stopRes = stopCall.successResult as Map<*, *>
        assertEquals(true, stopRes["success"])
        assertNull(callCoordinator("getDurableOwner", emptyMap()).successResult)

        // Now the queued START command executes!
        DutyForegroundService.executePendingStartsForTesting()

        // Effective execution boundary fence verified: service is NOT running
        assertFalse("Service must NOT be running without an owner", DutyForegroundService.isRunning)
    }

    // =========================================================================
    // Mandatory Scenario B: S1 START queued; S2 becomes owner; delayed S1 START delivered.
    // S1 does not start or replace S2.
    // =========================================================================
    @Test
    fun testScenarioB_S1StartQueued_S2BecomesOwner_DelayedS1StartDelivered_S1DoesNotReplaceS2() {
        val s1Intent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_START
            putExtra(DutyForegroundService.EXTRA_UID, "driver_B")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_B_1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
            putExtra(DutyForegroundService.EXTRA_CALLBACK_HANDLE, 10001L)
        }

        // S2 registers and starts service
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_B_2")
            put("uid", "driver_B")
            put("generation", 2)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val s2StartCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_B_2",
            "uid" to "driver_B",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertEquals(true, (s2StartCall.successResult as Map<*, *>)["success"])
        assertEquals("sess_B_2", DutyForegroundService.activeSessionId)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)

        // Delayed S1 START delivered to service
        fakeService.onStartCommand(s1Intent, 0, 2)

        // S2 remains authoritative and untouched
        assertEquals("sess_B_2", DutyForegroundService.activeSessionId)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)
        assertEquals(2, DutyForegroundService.activeGeneration)
    }

    // =========================================================================
    // Mandatory Scenario C: S1 STOP queued; S2 becomes owner; delayed S1 STOP delivered.
    // S2 survives.
    // =========================================================================
    @Test
    fun testScenarioC_S1StopQueued_S2BecomesOwner_DelayedS1StopDelivered_S2Survives() {
        // S2 is running
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_C_2")
            put("uid", "driver_C")
            put("generation", 2)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_C_2",
            "uid" to "driver_C",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("sess_C_2", DutyForegroundService.activeSessionId)

        // Delayed S1 STOP delivered
        val s1StopIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_C")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_C_1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
        }
        fakeService.onStartCommand(s1StopIntent, 0, 3)

        // S2 must survive untouched!
        assertTrue("S2 must survive delayed S1 stop", DutyForegroundService.isRunning)
        assertEquals("sess_C_2", DutyForegroundService.activeSessionId)
    }

    // =========================================================================
    // Mandatory Scenario D: STOP reports success only after effective completion acknowledgment.
    // =========================================================================
    @Test
    fun testScenarioD_StopReportsSuccessOnlyAfterEffectiveCompletion() {
        val payload = JSONObject().apply {
            put("sessionId", "sess_D")
            put("uid", "driver_D")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_D",
            "uid" to "driver_D",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)

        val stopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_D",
            "expectedSessionId" to "sess_D",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val stopRes = stopCall.successResult as Map<*, *>
        assertEquals(true, stopRes["success"])
        assertEquals(true, stopRes["stopped"])
        assertFalse("Effective stop must set isRunning to false before returning", DutyForegroundService.isRunning)

        // Repeating stop on already stopped service reports stopped = false without failure
        val repeatStopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_D",
            "expectedSessionId" to "sess_D",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val repeatStopRes = repeatStopCall.successResult as Map<*, *>
        assertEquals(true, repeatStopRes["success"])
        assertEquals(false, repeatStopRes["stopped"])
        assertEquals("no_active_owner", repeatStopRes["reason"])
    }

    // =========================================================================
    // Mandatory Scenario E: Initial persistence returns false or throws; reconstruct coordinator.
    // No falsely authorized owner.
    // =========================================================================
    @Test
    fun testScenarioE_InitialPersistenceReturnsFalseOrThrows_ReconstructCoordinator_NoFalselyAuthorizedOwner() {
        NativeOwnershipCoordinator.testCommitFailureInjector = { op -> op == "start_payload" }

        val payload = JSONObject().apply {
            put("sessionId", "sess_E")
            put("uid", "driver_E")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val startCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_E",
            "uid" to "driver_E",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        val startRes = startCall.successResult as Map<*, *>
        assertEquals(false, startRes["success"])
        assertEquals("commit_failed", startRes["reason"])

        // Reconstruct coordinator
        NativeOwnershipCoordinator.resetForTesting(fakeContext)
        val ownerCall = callCoordinator("getDurableOwner", emptyMap())
        assertNull("Zero falsely authorized owner must appear after reconstruction", ownerCall.successResult)
    }

    // =========================================================================
    // Mandatory Scenario F: ACTIVE-state commit fails.
    // Startup is not reported successful.
    // =========================================================================
    @Test
    fun testScenarioF_ActiveStateCommitFails_StartupNotReportedSuccessful() {
        DutyForegroundService.testCommitFailureInjector = { op -> op == "active_commit" }

        val s1Intent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_START
            putExtra(DutyForegroundService.EXTRA_UID, "driver_F")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_F")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 1L)
            putExtra(DutyForegroundService.EXTRA_CALLBACK_HANDLE, 10001L)
        }

        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_F")
            put("uid", "driver_F")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_F",
            "uid" to "driver_F",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        fakeService.onStartCommand(s1Intent, 0, 1)

        assertFalse("Startup must not be successful if ACTIVE-state commit fails", DutyForegroundService.isRunning)
    }

    // =========================================================================
    // Mandatory Scenario G: Rollback commit fails; reconstruct coordinator.
    // Failed ownership cannot silently become active.
    // =========================================================================
    @Test
    fun testScenarioG_RollbackCommitFails_ReconstructCoordinator_FailedOwnershipCannotSilentlyBecomeActive() {
        // Force commit to fail on rollback
        val payload = JSONObject().apply {
            put("sessionId", "sess_G")
            put("uid", "driver_G")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_G",
            "uid" to "driver_G",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        // Set state to FAILED_CLEANUP simulating failed rollback
        val ownerJson = testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, "{}") ?: "{}"
        val updatedObj = JSONObject(ownerJson).apply {
            put("state", NativeOwnershipCoordinator.STATE_FAILED_CLEANUP)
        }
        testPrefs.edit()
            .putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, updatedObj.toString())
            .putString(NativeOwnershipCoordinator.KEY_OWNER_STATE, NativeOwnershipCoordinator.STATE_FAILED_CLEANUP)
            .commit()

        // Reconstruct coordinator
        NativeOwnershipCoordinator.resetForTesting(fakeContext)

        // Attempting to run execution boundary against FAILED_CLEANUP state must be rejected
        val boundaryIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_START
            putExtra(DutyForegroundService.EXTRA_UID, "driver_G")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_G")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 1L)
            putExtra(DutyForegroundService.EXTRA_CALLBACK_HANDLE, 10001L)
        }
        fakeService.onStartCommand(boundaryIntent, 0, 1)

        assertFalse("Failed ownership cannot silently become active", DutyForegroundService.isRunning)
    }

    // =========================================================================
    // Mandatory Scenario H: Native STOP fails; authorized retry succeeds with owner/payload intact.
    // =========================================================================
    @Test
    fun testScenarioH_NativeStopFails_AuthorizedRetrySucceeds_OwnerAndPayloadIntact() {
        val payload = JSONObject().apply {
            put("sessionId", "sess_H")
            put("uid", "driver_H")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_H",
            "uid" to "driver_H",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        // Native stop removal commit fails
        NativeOwnershipCoordinator.testCommitFailureInjector = { op -> op == "stop_removal" }
        val failedStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_H",
            "expectedSessionId" to "sess_H",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val failedRes = failedStop.successResult as Map<*, *>
        assertEquals(false, failedRes["success"])

        // Check that owner record AND worker payload are both retained!
        assertNotNull(callCoordinator("getDurableOwner", emptyMap()).successResult)
        assertNotNull(callCoordinator("getWorkerPayload", emptyMap()).successResult)

        // Clear injector and retry stop
        NativeOwnershipCoordinator.testCommitFailureInjector = null
        val retryStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_H",
            "expectedSessionId" to "sess_H",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val retryRes = retryStop.successResult as Map<*, *>
        assertEquals(true, retryRes["success"])
        assertNull(callCoordinator("getDurableOwner", emptyMap()).successResult)
        assertNull(callCoordinator("getWorkerPayload", emptyMap()).successResult)
    }

    // =========================================================================
    // Mandatory Scenario I: Owner removal returns false or throws.
    // Dart reports failure and cleanup authority is preserved.
    // =========================================================================
    @Test
    fun testScenarioI_OwnerRemovalReturnsFalseOrThrows_DartReportsFailureAndCleanupAuthorityPreserved() {
        val payload = JSONObject().apply {
            put("sessionId", "sess_I")
            put("uid", "driver_I")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_I",
            "uid" to "driver_I",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        NativeOwnershipCoordinator.testCommitFailureInjector = { op -> op == "remove_owner" }
        val removeCall = callCoordinator("atomicRemoveOwner", mapOf(
            "expectedUid" to "driver_I",
            "expectedSessionId" to "sess_I",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        val removeRes = removeCall.successResult as Map<*, *>
        assertEquals(false, removeRes["success"])
        assertEquals(false, removeRes["removed"])
        assertEquals("commit_failed", removeRes["reason"])

        // Authority and payload preserved
        assertNotNull(callCoordinator("getDurableOwner", emptyMap()).successResult)
        assertNotNull(callCoordinator("getWorkerPayload", emptyMap()).successResult)
    }

    // =========================================================================
    // Mandatory Scenario J: Same session ID with newer generation/sequence
    // cannot be stopped or removed using old caller's token.
    // =========================================================================
    @Test
    fun testScenarioJ_SameSessionId_DifferentGenerationFencing() {
        val gen1Payload = JSONObject().apply {
            put("sessionId", "sess_J")
            put("uid", "driver_J")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_J",
            "uid" to "driver_J",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 1L,
            "sessionPayloadJson" to gen1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        val gen2Payload = JSONObject().apply {
            put("sessionId", "sess_J")
            put("uid", "driver_J")
            put("generation", 2)
            put("lifecycleSeq", 2L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_J",
            "uid" to "driver_J",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 2L,
            "sessionPayloadJson" to gen2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        // Stale caller with generation 1 attempts stop against active generation 2
        val staleGenCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_J",
            "expectedSessionId" to "sess_J",
            "expectedLifecycleSeq" to 2L,
            "expectedGeneration" to 1
        ))
        val staleGenRes = staleGenCall.successResult as Map<*, *>
        assertEquals(false, staleGenRes["success"])
        assertEquals("generation_mismatch", staleGenRes["reason"])
        assertTrue(DutyForegroundService.isRunning)

        // Matching generation 2 stop succeeds
        val validCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_J",
            "expectedSessionId" to "sess_J",
            "expectedLifecycleSeq" to 2L,
            "expectedGeneration" to 2
        ))
        val validRes = validCall.successResult as Map<*, *>
        assertEquals(true, validRes["success"])
        assertEquals(true, validRes["stopped"])
        assertFalse(DutyForegroundService.isRunning)
    }

    // =========================================================================
    // Mandatory Scenario K: Worker initialization fails before normal session setup.
    // Bootstrap cleanup retains the correct token.
    // =========================================================================
    @Test
    fun testScenarioK_WorkerInitializationBootstrapCleanupToken() {
        val payload = JSONObject().apply {
            put("sessionId", "sess_K")
            put("uid", "driver_K")
            put("generation", 3)
            put("lifecycleSeq", 50L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_K",
            "uid" to "driver_K",
            "dutyGeneration" to 3,
            "lifecycleSeq" to 50L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        // Bootstrap cleanup requires the EXACT captured token
        val stopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_K",
            "expectedSessionId" to "sess_K",
            "expectedLifecycleSeq" to 50L,
            "expectedGeneration" to 3
        ))
        val stopRes = stopCall.successResult as Map<*, *>
        assertEquals(true, stopRes["success"])
        assertNull(callCoordinator("getDurableOwner", emptyMap()).successResult)
    }

    // =========================================================================
    // Mandatory Scenario L: Malformed owner/payload/command metadata fails closed.
    // =========================================================================
    @Test
    fun testScenarioL_MalformedOwnerPayloadCommandMetadataFailsClosed() {
        // Disagreeing argument sequence 10 vs payload sequence 1
        val disagreeSeqPayload = JSONObject().apply {
            put("sessionId", "sess_L")
            put("uid", "driver_L")
            put("generation", 1)
            put("lifecycleSeq", 1L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val res1 = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_L",
            "uid" to "driver_L",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to disagreeSeqPayload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertEquals("INVALID_PAYLOAD", res1.errorCode)

        // Missing expectedGeneration on stop
        val res2 = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_L",
            "expectedSessionId" to "sess_L",
            "expectedLifecycleSeq" to 1L
        ))
        assertEquals("INVALID_ARGUMENT", res2.errorCode)

        // Negative expectedLifecycleSeq on stop
        val res3 = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_L",
            "expectedSessionId" to "sess_L",
            "expectedLifecycleSeq" to -1L,
            "expectedGeneration" to 1
        ))
        assertEquals("INVALID_ARGUMENT", res3.errorCode)

        // Missing expectedUid on stop
        val resMissingUid = callCoordinator("atomicStopService", mapOf(
            "expectedSessionId" to "sess_L",
            "expectedLifecycleSeq" to 1L,
            "expectedGeneration" to 1
        ))
        assertEquals("INVALID_ARGUMENT", resMissingUid.errorCode)

        // Corrupt owner JSON
        testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, "{corrupt_not_json}").commit()
        val resCorrupt = callCoordinator("getDurableOwner", emptyMap())
        assertEquals("CORRUPT_RECORD", resCorrupt.errorCode)
    }

    // =========================================================================
    // Mandatory Scenario M: Main and background engines observe same canonical ownership.
    // =========================================================================
    @Test
    fun testScenarioM_MainAndBackgroundEnginesObserveSameCanonicalOwnership() {
        val payload = JSONObject().apply {
            put("sessionId", "sess_M")
            put("uid", "driver_M")
            put("generation", 2)
            put("lifecycleSeq", 100L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_M",
            "uid" to "driver_M",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 100L,
            "sessionPayloadJson" to payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))

        val mainOwnerJson = callCoordinator("getDurableOwner", emptyMap()).successResult as String
        val backgroundPayloadJson = callCoordinator("getWorkerPayload", emptyMap()).successResult as String

        val mainObj = JSONObject(mainOwnerJson)
        val bgObj = JSONObject(backgroundPayloadJson)

        assertEquals("sess_M", mainObj.getString("sessionId"))
        assertEquals("sess_M", bgObj.getString("sessionId"))
        assertEquals("driver_M", mainObj.getString("uid"))
        assertEquals("driver_M", bgObj.getString("uid"))
        assertEquals(2, mainObj.getInt("generation"))
        assertEquals(2, bgObj.getInt("generation"))
        assertEquals(100L, mainObj.getLong("lifecycleSeq"))
        assertEquals(100L, bgObj.getLong("lifecycleSeq"))
    }

    // =========================================================================
    // Checkpoint 1 Mandatory Exit Test A: Rejection of malformed/mismatched destructive tokens
    // =========================================================================
    @Test
    fun testCheckpoint1_TestA_RejectionOfMalformedAndMismatchedDestructiveTokens() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_A1")
            put("uid", "driver_A1")
            put("generation", 1)
            put("lifecycleSeq", 10L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val startCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_A1",
            "uid" to "driver_A1",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue((startCall.successResult as Map<*, *>)["success"] as Boolean)
        assertTrue(DutyForegroundService.isRunning)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)

        // 1. Astra emulator repro: STOP Intent with WRONG UID and OMITTED GENERATION
        val reproIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_WRONG")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_A1")
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
            // EXTRA_GENERATION intentionally OMITTED!
        }
        fakeService.onStartCommand(reproIntent, 0, 1)
        assertTrue("Service MUST remain running after repro stop intent", DutyForegroundService.isRunning)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)
        val ownerAfterRepro = JSONObject(callCoordinator("getDurableOwner", emptyMap()).successResult as String)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, ownerAfterRepro.getString("state"))
        assertEquals("driver_A1", ownerAfterRepro.getString("uid"))

        // 2. STOP Intent with matching session/seq, but wrong UID
        val wrongUidIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_WRONG")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_A1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
        }
        fakeService.onStartCommand(wrongUidIntent, 0, 1)
        assertTrue("Service MUST remain running after wrong UID intent", DutyForegroundService.isRunning)

        // 3. STOP Intent with negative generation
        val negGenIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_A1")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_A1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, -1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
        }
        fakeService.onStartCommand(negGenIntent, 0, 1)
        assertTrue("Service MUST remain running after negative generation intent", DutyForegroundService.isRunning)

        // 4. STOP Intent with sequence <= 0
        val zeroSeqIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_A1")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_A1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 0L)
        }
        fakeService.onStartCommand(zeroSeqIntent, 0, 1)
        assertTrue("Service MUST remain running after sequence <= 0 intent", DutyForegroundService.isRunning)

        // 5. STOP Intent with sequence older than canonical (e.g. 5L vs 10L)
        val oldSeqIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_A1")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_A1")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 5L)
        }
        fakeService.onStartCommand(oldSeqIntent, 0, 1)
        assertTrue("Service MUST remain running after old sequence intent", DutyForegroundService.isRunning)

        // 6. STOP Intent with session ID mismatch
        val wrongSessIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_A1")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_WRONG")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 1)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
        }
        fakeService.onStartCommand(wrongSessIntent, 0, 1)
        assertTrue("Service MUST remain running after session ID mismatch intent", DutyForegroundService.isRunning)

        // 7. atomicStopService with wrong UID
        val wrongUidCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_WRONG",
            "expectedSessionId" to "sess_A1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 10L
        ))
        val wrongUidRes = wrongUidCall.successResult as Map<*, *>
        assertEquals(false, wrongUidRes["success"])
        assertEquals("uid_mismatch", wrongUidRes["reason"])
        assertTrue(DutyForegroundService.isRunning)

        // 8. atomicStopService with missing expectedUid
        val missingUidCall = callCoordinator("atomicStopService", mapOf(
            "expectedSessionId" to "sess_A1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 10L
        ))
        assertEquals("INVALID_ARGUMENT", missingUidCall.errorCode)
        assertTrue(DutyForegroundService.isRunning)

        // Final assertion: none of these terminated the service, killed the worker, or cleared canonical state
        assertTrue(DutyForegroundService.isRunning)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)
        val finalOwner = JSONObject(callCoordinator("getDurableOwner", emptyMap()).successResult as String)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, finalOwner.getString("state"))
        assertEquals("sess_A1", finalOwner.getString("sessionId"))
        assertEquals("driver_A1", finalOwner.getString("uid"))
    }

    // =========================================================================
    // Checkpoint 1 Mandatory Exit Test B: Truthful teardown completion & teardown failure handling
    // =========================================================================
    @Test
    fun testCheckpoint1_TestB_TruthfulTeardownCompletionAndTeardownFailureHandling() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_B1")
            put("uid", "driver_B1")
            put("generation", 1)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_B1",
            "uid" to "driver_B1",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)

        // Intercept teardown destruction to delay completion
        var interceptedProceed: ((Boolean, String?) -> Unit)? = null
        DutyForegroundService.teardownInterceptor = { token, proceed ->
            interceptedProceed = proceed
        }

        // Submit valid STOP
        val stopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_B1",
            "expectedSessionId" to "sess_B1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 20L
        ))

        // Assert: STOP completion / stopped=true is NOT returned while teardown is pending!
        assertNull("STOP completion must NOT be returned while teardown is pending", stopCall.successResult)
        assertNull("No error while pending", stopCall.errorCode)
        assertNotNull("Teardown proceed callback was captured", interceptedProceed)
        assertTrue("Service remains running during pending teardown", DutyForegroundService.isRunning)

        // Now release destruction
        interceptedProceed!!.invoke(true, null)

        // Assert: stopped=true is returned only AFTER destruction finishes
        assertNotNull("STOP completion returned after destruction finishes", stopCall.successResult)
        val stopRes = stopCall.successResult as Map<*, *>
        assertEquals(true, stopRes["success"])
        assertEquals(true, stopRes["stopped"])
        assertFalse("No ownerless running service remains in Android runtime", DutyForegroundService.isRunning)
        assertNull(callCoordinator("getDurableOwner", emptyMap()).successResult)

        // --- Separate Run: Teardown Failure Injection ---
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_B2")
            put("uid", "driver_B2")
            put("generation", 1)
            put("lifecycleSeq", 30L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_B2",
            "uid" to "driver_B2",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 30L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)

        // Inject teardown failure
        DutyForegroundService.teardownInterceptor = { token, proceed ->
            proceed(false, "Simulated destruction failure")
        }

        val failedStopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_B2",
            "expectedSessionId" to "sess_B2",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 30L
        ))

        // Assert: actionable error returned
        assertEquals("NATIVE_STOP_FAILED", failedStopCall.errorCode)
        assertEquals("Simulated destruction failure", failedStopCall.errorMessage)

        // Assert: state is marked FAILED_CLEANUP and canonical owner is NOT cleared
        val retainedOwnerJson = callCoordinator("getDurableOwner", emptyMap()).successResult as String
        val retainedOwner = JSONObject(retainedOwnerJson)
        assertEquals(NativeOwnershipCoordinator.STATE_FAILED_CLEANUP, retainedOwner.getString("state"))
        assertEquals("sess_B2", retainedOwner.getString("sessionId"))
        assertEquals("driver_B2", retainedOwner.getString("uid"))
    }

    // =========================================================================
    // Checkpoint 1 Mandatory Exit Test C: Interleaved replacement during teardown
    // =========================================================================
    @Test
    fun testCheckpoint1_TestC_InterleavedReplacementDuringTeardown() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_C1")
            put("uid", "driver_C")
            put("generation", 1)
            put("lifecycleSeq", 10L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_C1",
            "uid" to "driver_C",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("sess_C1", DutyForegroundService.activeSessionId)

        // Submit STOP for S1, but delay completion of S1's task destruction
        var s1Proceed: ((Boolean, String?) -> Unit)? = null
        DutyForegroundService.teardownInterceptor = { token, proceed ->
            if (token.sessionId == "sess_C1") {
                s1Proceed = proceed
            } else {
                proceed(true, null)
            }
        }

        val s1StopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_C",
            "expectedSessionId" to "sess_C1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 10L
        ))
        assertNotNull("S1 teardown was intercepted and held", s1Proceed)

        // Before S1 destruction completes, submit a valid START for S2
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_C2")
            put("uid", "driver_C")
            put("generation", 2)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val s2StartCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_C2",
            "uid" to "driver_C",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10002L)
        ))
        val s2StartRes = s2StartCall.successResult as Map<*, *>
        assertEquals(true, s2StartRes["success"])

        // Assert: S2 successfully becomes the active owner and runs
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("sess_C2", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)

        // Now allow S1 destruction to complete
        s1Proceed!!.invoke(true, null)

        // Assert: S1 completion does NOT terminate S2's service
        assertTrue("S2 service MUST remain running after S1 teardown completes", DutyForegroundService.isRunning)

        // Assert: S1 completion does NOT kill S2's worker task or reset active session
        assertEquals("sess_C2", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)

        // Assert: S1 completion does NOT clear S2's owner record or payload
        val s2OwnerJson = callCoordinator("getDurableOwner", emptyMap()).successResult as String
        val s2Owner = JSONObject(s2OwnerJson)
        assertEquals("sess_C2", s2Owner.getString("sessionId"))
        assertEquals("driver_C", s2Owner.getString("uid"))
        assertEquals(2, s2Owner.getInt("generation"))
        assertEquals(20L, s2Owner.getLong("lifecycleSeq"))
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, s2Owner.getString("state"))

        val s2WorkerPayload = callCoordinator("getWorkerPayload", emptyMap()).successResult as String
        val s2PayloadObj = JSONObject(s2WorkerPayload)
        assertEquals("sess_C2", s2PayloadObj.getString("sessionId"))

        // S2 remains fully active and authoritative!
    }

    // =========================================================================
    // Checkpoint 1 Targeted Repair 1: Reject fractional, string-coerced, NaN,
    // infinity, and overflowing epoch values
    // =========================================================================
    @Test
    fun testCheckpoint1_Repair1_RejectFractionalEpochValues() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_frac")
            put("uid", "driver_frac")
            put("generation", 2)
            put("lifecycleSeq", 10L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_frac",
            "uid" to "driver_frac",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)

        // 1. Fractional expectedGeneration (2.9) rejected by atomicStopService
        val fracGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_frac",
            "expectedSessionId" to "sess_frac",
            "expectedGeneration" to 2.9,
            "expectedLifecycleSeq" to 10L
        ))
        assertEquals("INVALID_ARGUMENT", fracGenStop.errorCode)
        assertTrue("Service remains running after fractional generation stop", DutyForegroundService.isRunning)

        // 2. Fractional expectedLifecycleSeq (10.9) rejected by atomicStopService
        val fracSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_frac",
            "expectedSessionId" to "sess_frac",
            "expectedGeneration" to 2,
            "expectedLifecycleSeq" to 10.9
        ))
        assertEquals("INVALID_ARGUMENT", fracSeqStop.errorCode)
        assertTrue("Service remains running after fractional sequence stop", DutyForegroundService.isRunning)

        // 3. Fractional expectedGeneration (2.9) rejected by atomicRemoveOwner
        val fracGenRemove = callCoordinator("atomicRemoveOwner", mapOf(
            "expectedUid" to "driver_frac",
            "expectedSessionId" to "sess_frac",
            "expectedGeneration" to 2.9,
            "expectedLifecycleSeq" to 10L
        ))
        assertEquals("INVALID_ARGUMENT", fracGenRemove.errorCode)

        // 4. Fractional expectedLifecycleSeq (10.9) rejected by atomicRemoveOwner
        val fracSeqRemove = callCoordinator("atomicRemoveOwner", mapOf(
            "expectedUid" to "driver_frac",
            "expectedSessionId" to "sess_frac",
            "expectedGeneration" to 2,
            "expectedLifecycleSeq" to 10.9
        ))
        assertEquals("INVALID_ARGUMENT", fracSeqRemove.errorCode)

        // 5. Fractional dutyGeneration (2.9) rejected by atomicStartService
        val fracGenStart = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_frac_2",
            "uid" to "driver_frac",
            "dutyGeneration" to 2.9,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertEquals("INVALID_ARGUMENT", fracGenStart.errorCode)

        // 6. Fractional lifecycleSeq (20.9) rejected by atomicStartService
        val fracSeqStart = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_frac_2",
            "uid" to "driver_frac",
            "dutyGeneration" to 3,
            "lifecycleSeq" to 20.9,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertEquals("INVALID_ARGUMENT", fracSeqStart.errorCode)

        // 7. Intent ACTION_STOP with fractional generation (2.9) rejected by service
        val fracGenIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_frac")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_frac")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 2.9)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10L)
        }
        fakeService.onStartCommand(fracGenIntent, 0, 1)
        assertTrue("Service MUST remain running after intent with fractional generation", DutyForegroundService.isRunning)

        // 8. Intent ACTION_STOP with fractional sequence (10.9) rejected by service
        val fracSeqIntent = DutyIntent(fakeContext, DutyForegroundService::class.java).apply {
            action = DutyForegroundService.ACTION_STOP
            putExtra(DutyForegroundService.EXTRA_UID, "driver_frac")
            putExtra(DutyForegroundService.EXTRA_SESSION_ID, "sess_frac")
            putExtra(DutyForegroundService.EXTRA_GENERATION, 2)
            putExtra(DutyForegroundService.EXTRA_LIFECYCLE_SEQ, 10.9)
        }
        fakeService.onStartCommand(fracSeqIntent, 0, 1)
        assertTrue("Service MUST remain running after intent with fractional sequence", DutyForegroundService.isRunning)

        // 9. Valid integer token succeeds without error
        val validStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_frac",
            "expectedSessionId" to "sess_frac",
            "expectedGeneration" to 2,
            "expectedLifecycleSeq" to 10L
        ))
        val validRes = validStop.successResult as Map<*, *>
        assertEquals(true, validRes["success"])
        assertEquals(true, validRes["stopped"])
        assertFalse("Service stopped after valid integer token", DutyForegroundService.isRunning)
    }

    @Test
    fun testCheckpoint1_Repair1_RejectStringCoercion_NaN_Infinity_AndOverflow() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_coercion")
            put("uid", "driver_coercion")
            put("generation", 1)
            put("lifecycleSeq", 5L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_coercion",
            "uid" to "driver_coercion",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 5L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)

        // String coerced values rejected
        val strGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to "1",
            "expectedLifecycleSeq" to 5L
        ))
        assertEquals("INVALID_ARGUMENT", strGenStop.errorCode)

        val strSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to "5"
        ))
        assertEquals("INVALID_ARGUMENT", strSeqStop.errorCode)

        // NaN rejected
        val nanGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to Double.NaN,
            "expectedLifecycleSeq" to 5L
        ))
        assertEquals("INVALID_ARGUMENT", nanGenStop.errorCode)

        val nanSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to Double.NaN
        ))
        assertEquals("INVALID_ARGUMENT", nanSeqStop.errorCode)

        // Infinity rejected
        val infGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to Double.POSITIVE_INFINITY,
            "expectedLifecycleSeq" to 5L
        ))
        assertEquals("INVALID_ARGUMENT", infGenStop.errorCode)

        val infSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to Double.POSITIVE_INFINITY
        ))
        assertEquals("INVALID_ARGUMENT", infSeqStop.errorCode)

        // Overflowing double rejected
        val overflowGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to Double.MAX_VALUE,
            "expectedLifecycleSeq" to 5L
        ))
        assertEquals("INVALID_ARGUMENT", overflowGenStop.errorCode)

        val overflowSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to Double.MAX_VALUE
        ))
        assertEquals("INVALID_ARGUMENT", overflowSeqStop.errorCode)

        // Negative values rejected
        val negGenStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to -1,
            "expectedLifecycleSeq" to 5L
        ))
        assertEquals("INVALID_ARGUMENT", negGenStop.errorCode)

        val negSeqStop = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_coercion",
            "expectedSessionId" to "sess_coercion",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to -5L
        ))
        assertEquals("INVALID_ARGUMENT", negSeqStop.errorCode)

        // Service is still running after all invalid attempts
        assertTrue(DutyForegroundService.isRunning)
    }

    // =========================================================================
    // Checkpoint 1 Targeted Repair 2 & 3: Bound Task Destruction Lifecycle and
    // Delayed Failure Callback Storage Fencing
    // =========================================================================
    @Test
    fun testCheckpoint1_Repair3_S1DelayedFailureDoesNotCorruptS2StorageOrActiveState() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_F1")
            put("uid", "driver_F")
            put("generation", 1)
            put("lifecycleSeq", 10L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_F1",
            "uid" to "driver_F",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("sess_F1", DutyForegroundService.activeSessionId)

        // S1 stop initiated, delayed via teardown interceptor
        var s1Proceed: ((Boolean, String?) -> Unit)? = null
        DutyForegroundService.teardownInterceptor = { token, proceed ->
            if (token.sessionId == "sess_F1") {
                s1Proceed = proceed
            } else {
                proceed(true, null)
            }
        }

        val s1StopCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_F",
            "expectedSessionId" to "sess_F1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 10L
        ))
        assertNotNull("S1 teardown was intercepted and held", s1Proceed)

        // S2 registers and starts while S1 teardown is pending
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_F2")
            put("uid", "driver_F")
            put("generation", 2)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val s2StartCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_F2",
            "uid" to "driver_F",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10002L)
        ))
        val s2StartRes = s2StartCall.successResult as Map<*, *>
        assertEquals(true, s2StartRes["success"])
        assertEquals("sess_F2", DutyForegroundService.activeSessionId)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)

        // S1 delayed destruction now fails!
        s1Proceed!!.invoke(false, "Simulated S1 delayed destruction failure")

        // S1 failure callback must NOT corrupt S2's active state
        assertTrue("S2 MUST remain running after S1 delayed failure", DutyForegroundService.isRunning)
        assertEquals("sess_F2", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)

        // S1 failure callback must NOT corrupt S2's durable storage record
        val durableOwnerJson = callCoordinator("getDurableOwner", emptyMap()).successResult as String
        val durableOwner = JSONObject(durableOwnerJson)
        assertEquals("sess_F2", durableOwner.getString("sessionId"))
        assertEquals(2, durableOwner.getInt("generation"))
        assertEquals(20L, durableOwner.getLong("lifecycleSeq"))
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, durableOwner.getString("state"))
    }

    @Test
    fun testCheckpoint1_FindingA_MalformedPersistedOwnerRejectedAcrossGetOwnerAndServiceRestart() {
        val malformedVariants = listOf(
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", 2.9).put("lifecycleSeq", 10).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", 2).put("lifecycleSeq", 10.9).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", "2").put("lifecycleSeq", 10).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", 2).put("lifecycleSeq", "10").put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", -1).put("lifecycleSeq", 10).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", 2).put("lifecycleSeq", -1L).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "").put("sessionId", "S").put("generation", 2).put("lifecycleSeq", 10).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "").put("generation", 2).put("lifecycleSeq", 10).put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z"),
            JSONObject().put("uid", "U").put("sessionId", "S").put("generation", 2).put("lifecycleSeq", 10).put("state", "UNKNOWN").put("startedAt", "2026-09-22T00:00:00Z")
        )

        for (malformed in malformedVariants) {
            setUp()
            testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, malformed.toString()).commit()

            val getRes = callCoordinator("getDurableOwner", emptyMap())
            assertEquals("CORRUPT_RECORD", getRes.errorCode)

            val restartIntent = DutyIntent(DutyForegroundService.ACTION_RESTART)
            val res = fakeService.onStartCommand(restartIntent, 0, 1)
            assertEquals(android.app.Service.START_NOT_STICKY, res)
            assertFalse(DutyForegroundService.isRunning)
            assertNull(DutyForegroundService.activeSessionId)
            assertNull(DutyForegroundService.activeGeneration)
            assertNull(DutyForegroundService.activeLifecycleSeq)
            assertEquals(NativeOwnershipCoordinator.STATE_STOPPED, DutyForegroundService.activeState)
        }
    }

    @Test
    fun testCheckpoint1_FindingA_ValidPersistedOwnerRestoresActiveState() {
        val validRecord = JSONObject().apply {
            put("uid", "U_VALID")
            put("sessionId", "S_VALID")
            put("generation", 2)
            put("lifecycleSeq", 10L)
            put("state", "ACTIVE")
            put("startedAt", "2026-09-22T00:00:00Z")
        }
        testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, validRecord.toString()).commit()
        testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, validRecord.toString()).commit()
        testPrefs.edit().putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, 10L).commit()
        testPrefs.edit().putLong(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, -3203216811206231334L).commit()
        NativeOwnershipCoordinator.setRestartReadinessGrant(testPrefs, SessionToken("U_VALID", "S_VALID", 2, 10L))

        val getRes = callCoordinator("getDurableOwner", emptyMap())
        assertNull(getRes.errorCode)
        assertNotNull(getRes.successResult)

        val restartIntent = DutyIntent(DutyForegroundService.ACTION_RESTART)
        val res = fakeService.onStartCommand(restartIntent, 0, 1)
        assertEquals(android.app.Service.START_STICKY, res)
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("U_VALID", DutyForegroundService.activeUid)
        assertEquals("S_VALID", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(10L, DutyForegroundService.activeLifecycleSeq)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)
    }

    private fun persistRestartCandidate() {
        val record = JSONObject()
            .put("uid", "U_RESTART").put("sessionId", "S_RESTART")
            .put("generation", 2).put("lifecycleSeq", 10L)
            .put("state", "ACTIVE").put("startedAt", "2026-09-22T00:00:00Z")
        testPrefs.edit()
            .putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, record.toString())
            .putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, record.toString())
            .putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, 10L)
            .putLong(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, 10001L)
            .commit()
        assertTrue(NativeOwnershipCoordinator.setRestartReadinessGrant(
            testPrefs, SessionToken("U_RESTART", "S_RESTART", 2, 10L)))
    }

    private fun assertRestartRejected() {
        val result = fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 1)
        assertEquals(android.app.Service.START_NOT_STICKY, result)
        assertFalse(DutyForegroundService.isRunning)
        assertFalse(DutyForegroundService.isHealthyRunning())
        assertEquals(NativeOwnershipCoordinator.STATE_STOPPED, DutyForegroundService.activeState)
        assertNull(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null))
        assertNull(NativeOwnershipCoordinator.getRestartReadinessGrant(testPrefs))
        assertNull(DutyForegroundService.activeTaskBinding)
        assertTrue(DutyForegroundService.taskBindings.isEmpty())
        assertNull(DutyForegroundService.getActiveToken())
        assertNull(DutyForegroundService.activeStartAuthorization)
        assertEquals(NativeOwnershipCoordinator.LIFECYCLE_TERMINAL_REVOKED,
            testPrefs.getString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, null))
    }

    @Test fun m1RST1_activeOwnerWithoutGrantFailsClosed() {
        persistRestartCandidate()
        testPrefs.edit()
            .remove(NativeOwnershipCoordinator.KEY_RESTART_READINESS_GRANT)
            .remove(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE)
            .commit()
        assertRestartRejected()
    }

    @Test fun m1RST2_activeOwnerWithoutLifecycleKeyFailsClosed() {
        persistRestartCandidate()
        testPrefs.edit().remove(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE).commit()
        assertRestartRejected()
    }

    @Test fun m1RST3_activeOwnerWithoutCallbackFailsClosed() {
        persistRestartCandidate()
        testPrefs.edit().remove(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE).commit()
        assertRestartRejected()
    }

    @Test fun m1RST4_completeGrantRestoresExactOwner() {
        persistRestartCandidate()
        val result = fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 1)
        assertEquals(android.app.Service.START_STICKY, result)
        assertTrue(DutyForegroundService.isHealthyRunning())
        assertEquals("U_RESTART", DutyForegroundService.activeUid)
        assertEquals("S_RESTART", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(10L, DutyForegroundService.activeLifecycleSeq)
        val exact = SessionToken("U_RESTART", "S_RESTART", 2, 10L)
        assertEquals(exact, DutyForegroundService.activeTaskBinding?.token)
        assertEquals(exact, NativeOwnershipCoordinator.getRestartReadinessGrant(testPrefs))
        assertEquals(10L, JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)!!).getLong("lifecycleSeq"))
        assertEquals(10L, testPrefs.getLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, -1))
    }

    @Test fun r11_invalidGrantLifecycleCallbackAndPayloadFailClosed() {
        val mutations: List<() -> Unit> = listOf(
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_RESTART_READINESS_GRANT, "{broken").commit(); Unit },
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_RESTART_READINESS_GRANT,
                JSONObject().put("uid", "U_RESTART").put("sessionId", "S_RESTART")
                    .put("generation", 2).put("lifecycleSeq", 11L).toString()).commit(); Unit },
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_RESTART_READINESS_GRANT,
                JSONObject().put("uid", "U_RESTART").put("sessionId", "S_RESTART")
                    .put("generation", 2).put("lifecycleSeq", "10").toString()).commit(); Unit },
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, "TERMINAL_REVOKED").commit(); Unit },
            { testPrefs.edit().putLong(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, 0L).commit(); Unit },
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, "10001").commit(); Unit },
            { val payload = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!)
                .put("callbackHandle", 10001L)
                testPrefs.edit().putLong(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, 0L)
                    .putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, payload.toString()).commit(); Unit },
            { val payload = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!)
                .put("callbackHandle", 10002L)
                testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, payload.toString()).commit(); Unit },
            { val payload = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!)
                .put("callbackHandle", "10001")
                testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, payload.toString()).commit(); Unit },
            { testPrefs.edit().putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, -1L).commit(); Unit },
            { testPrefs.edit().putFloat(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, 10.5f).commit(); Unit },
            { testPrefs.edit().remove(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE).commit(); Unit },
            { testPrefs.edit().remove(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD).commit(); Unit },
            { testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, "{broken").commit(); Unit },
            { val payload = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!)
                .put("lifecycleSeq", 11L)
                testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, payload.toString()).commit(); Unit },
            { val payload = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!)
                .put("lifecycleSeq", 10.5)
                testPrefs.edit().putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, payload.toString()).commit(); Unit }
        )
        for (mutate in mutations) {
            setUp()
            persistRestartCandidate()
            mutate()
            assertRestartRejected()
        }
    }

    @Test fun r11_failedWorkerReconstructionDoesNotFabricateBinding() {
        persistRestartCandidate()
        DutyForegroundService.testTaskCreationFailureInjector = { IllegalStateException("No worker binding") }
        assertRestartRejected()
    }

    @Test fun r11_missingDestroyedAndWrongEpochBindingsFailClosed() {
        val factories: List<(SessionToken) -> ServiceTaskBinding?> = listOf(
            { null },
            { token -> ServiceTaskBinding(token).apply { onLifecycleDestroyed(false, "Destroyed during reconstruction") } },
            { token -> ServiceTaskBinding(token.copy(lifecycleSeq = token.lifecycleSeq + 1)) }
        )
        for (factory in factories) {
            setUp()
            persistRestartCandidate()
            DutyForegroundService.testRestartBindingFactory = factory
            assertRestartRejected()
        }
    }

    private fun installNewerRestartOwner(newer: SessionToken): ServiceTaskBinding {
        val record = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)!!)
            .put("lifecycleSeq", newer.lifecycleSeq)
        testPrefs.edit()
            .putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, record.toString())
            .putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, record.toString())
            .putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, newer.lifecycleSeq)
            .putLong(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE, 10002L)
            .commit()
        NativeOwnershipCoordinator.setRestartReadinessGrant(testPrefs, newer)
        val previousFailure = DutyForegroundService.testRestartReconstructionFailureInjector
        val previousFactory = DutyForegroundService.testRestartBindingFactory
        DutyForegroundService.testRestartReconstructionFailureInjector = null
        DutyForegroundService.testRestartBindingFactory = null
        try {
            assertEquals(android.app.Service.START_STICKY,
                fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 2))
        } finally {
            DutyForegroundService.testRestartReconstructionFailureInjector = previousFailure
            DutyForegroundService.testRestartBindingFactory = previousFactory
        }
        DutyForegroundService.grantStartAuthorization(newer)
        return DutyForegroundService.activeTaskBinding!!
    }

    @Test fun r11_failedOldRestartProtectsNewerExactOwnerAndBinding() {
        persistRestartCandidate()
        val newer = SessionToken("U_RESTART", "S_RESTART", 2, 11L)
        lateinit var newerBinding: ServiceTaskBinding
        DutyForegroundService.testRestartReconstructionFailureInjector = {
            newerBinding = installNewerRestartOwner(newer)
            IllegalStateException("Old restart lost authority")
        }
        val result = fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 1)
        assertEquals(android.app.Service.START_NOT_STICKY, result)
        val record = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)!!)
        assertEquals(11L, record.getLong("lifecycleSeq"))
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, record.getString("state"))
        assertEquals(11L, JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)!!).getLong("lifecycleSeq"))
        assertEquals(newer, NativeOwnershipCoordinator.getRestartReadinessGrant(testPrefs))
        assertEquals(NativeOwnershipCoordinator.LIFECYCLE_PERMIT_RESTART,
            testPrefs.getString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, null))
        assertEquals(newer, DutyForegroundService.getActiveToken())
        assertEquals(newer, DutyForegroundService.activeStartAuthorization)
        assertSame(newerBinding, DutyForegroundService.activeTaskBinding)
        assertSame(newerBinding, DutyForegroundService.taskBindings[newer])
        assertFalse(newerBinding.isDestroyed)
        assertEquals(newer, DutyForegroundService.lockOwnerToken)
        assertTrue(DutyForegroundService.isHealthyRunning())
    }

    @Test fun r11_ownerAdvancedDuringReconstructionCannotPublishOldBinding() {
        persistRestartCandidate()
        val newer = SessionToken("U_RESTART", "S_RESTART", 2, 11L)
        lateinit var newerBinding: ServiceTaskBinding
        DutyForegroundService.testRestartBindingFactory = { oldToken ->
            newerBinding = installNewerRestartOwner(newer)
            ServiceTaskBinding(oldToken)
        }
        val result = fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 1)
        assertEquals(android.app.Service.START_NOT_STICKY, result)
        assertEquals(newer, DutyForegroundService.getActiveToken())
        assertSame(newerBinding, DutyForegroundService.activeTaskBinding)
        assertEquals(newer, NativeOwnershipCoordinator.getRestartReadinessGrant(testPrefs))
        assertEquals(11L, JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)!!).getLong("lifecycleSeq"))
        assertFalse(DutyForegroundService.taskBindings.containsKey(newer.copy(lifecycleSeq = 10L)))
        assertTrue(DutyForegroundService.isHealthyRunning())
    }

    @Test fun r11_ownerAdvancedDuringRollbackOrFailureStateCannotBeRevoked() {
        for (boundary in listOf("rollback", "failure_state")) {
            setUp()
            persistRestartCandidate()
            val newer = SessionToken("U_RESTART", "S_RESTART", 2, 11L)
            lateinit var newerBinding: ServiceTaskBinding
            NativeOwnershipCoordinator.testCommitFailureInjector = { operation ->
                if (operation == boundary) newerBinding = installNewerRestartOwner(newer)
                boundary == "failure_state" && operation == "rollback"
            }
            // The old restart has no callback and must fail, even if rollback
            // callbacks install a valid replacement before persistence completes.
            testPrefs.edit().remove(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE).commit()
            assertEquals(android.app.Service.START_NOT_STICKY,
                fakeService.onStartCommand(DutyIntent(DutyForegroundService.ACTION_RESTART), 0, 1))
            val record = JSONObject(testPrefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)!!)
            assertEquals(11L, record.getLong("lifecycleSeq"))
            assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, record.getString("state"))
            assertEquals(newer, NativeOwnershipCoordinator.getRestartReadinessGrant(testPrefs))
            assertEquals(newer, DutyForegroundService.getActiveToken())
            assertEquals(newer, DutyForegroundService.activeStartAuthorization)
            assertSame(newerBinding, DutyForegroundService.activeTaskBinding)
            assertEquals(newer, DutyForegroundService.lockOwnerToken)
            assertTrue(DutyForegroundService.isHealthyRunning())
        }
    }

    @Test
    fun testCheckpoint1_FindingC_GenuineUnfinishedS1TeardownFailureAndRetry() {
        val s1Payload = JSONObject().apply {
            put("sessionId", "sess_C1")
            put("uid", "driver_C")
            put("generation", 1)
            put("lifecycleSeq", 10L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_C1",
            "uid" to "driver_C",
            "dutyGeneration" to 1,
            "lifecycleSeq" to 10L,
            "sessionPayloadJson" to s1Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)
        ))
        assertTrue(DutyForegroundService.isRunning)
        assertEquals("sess_C1", DutyForegroundService.activeSessionId)

        // S1 stop initiated, delayed via teardown interceptor
        var s1Proceed: ((Boolean, String?) -> Unit)? = null
        DutyForegroundService.teardownInterceptor = { token, proceed ->
            if (token.sessionId == "sess_C1") {
                s1Proceed = proceed
            } else {
                proceed(true, null)
            }
        }

        val s1StopResultHolder = MockMethodResult()
        NativeOwnershipCoordinator.onMethodCall(
            MethodCall("atomicStopService", mapOf(
                "expectedUid" to "driver_C",
                "expectedSessionId" to "sess_C1",
                "expectedGeneration" to 1,
                "expectedLifecycleSeq" to 10L
            )),
            s1StopResultHolder
        )
        assertNotNull("S1 teardown was intercepted and held", s1Proceed)
        assertFalse("S1 stop has not replied while held", s1StopResultHolder.replied)

        // S2 registers and starts while S1 teardown is pending
        val s2Payload = JSONObject().apply {
            put("sessionId", "sess_C2")
            put("uid", "driver_C")
            put("generation", 2)
            put("lifecycleSeq", 20L)
            put("startedAt", "2026-09-21T00:00:00.000Z")
        }
        val s2StartCall = callCoordinator("atomicStartService", mapOf(
            "sessionId" to "sess_C2",
            "uid" to "driver_C",
            "dutyGeneration" to 2,
            "lifecycleSeq" to 20L,
            "sessionPayloadJson" to s2Payload.toString(),
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10002L)
        ))
        val s2StartRes = s2StartCall.successResult as Map<*, *>
        assertEquals(true, s2StartRes["success"])
        assertEquals("sess_C2", DutyForegroundService.activeSessionId)
        assertFalse("S1 stop must NOT have replied when S2 started", s1StopResultHolder.replied)

        // S1 delayed destruction now fails!
        s1Proceed!!.invoke(false, "Simulated S1 held destruction failure")
        assertTrue("S1 stop replied after failure callback", s1StopResultHolder.replied)
        assertEquals("NATIVE_STOP_FAILED", s1StopResultHolder.errorCode)

        // S2 MUST remain active, running, and authoritative
        assertTrue("S2 MUST remain running after S1 delayed failure", DutyForegroundService.isRunning)
        assertEquals("sess_C2", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)
        assertEquals(NativeOwnershipCoordinator.STATE_ACTIVE, DutyForegroundService.activeState)

        // S2 storage is preserved
        val ownerAfterS1Failure = JSONObject(callCoordinator("getDurableOwner", emptyMap()).successResult as String)
        assertEquals("sess_C2", ownerAfterS1Failure.getString("sessionId"))
        assertEquals(2, ownerAfterS1Failure.getInt("generation"))
        assertEquals(20L, ownerAfterS1Failure.getLong("lifecycleSeq"))

        // S1 retry STOP succeeds and cleans up S1's held binding
        DutyForegroundService.teardownInterceptor = null
        val s1RetryCall = callCoordinator("atomicStopService", mapOf(
            "expectedUid" to "driver_C",
            "expectedSessionId" to "sess_C1",
            "expectedGeneration" to 1,
            "expectedLifecycleSeq" to 10L
        ))
        val s1RetryRes = s1RetryCall.successResult as Map<*, *>
        assertEquals(true, s1RetryRes["success"])
        assertEquals(true, s1RetryRes["stopped"])

        // S2 remains running and authoritative after S1 retry completes!
        assertTrue("S2 MUST remain running after S1 retry", DutyForegroundService.isRunning)
        assertEquals("sess_C2", DutyForegroundService.activeSessionId)
        assertEquals(2, DutyForegroundService.activeGeneration)
        assertEquals(20L, DutyForegroundService.activeLifecycleSeq)
        val ownerAfterRetry = JSONObject(callCoordinator("getDurableOwner", emptyMap()).successResult as String)
        assertEquals("sess_C2", ownerAfterRetry.getString("sessionId"))
    }
}
