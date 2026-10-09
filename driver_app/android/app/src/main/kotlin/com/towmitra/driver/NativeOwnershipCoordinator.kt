package com.towmitra.driver

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

fun runOnMainThread(action: () -> Unit) {
    try {
        val looper = Looper.getMainLooper()
        if (looper != null && Looper.myLooper() != looper) {
            Handler(looper).post { action() }
            return
        }
    } catch (_: Throwable) {
        // Fallback for headless JVM test environments where android.os.Looper is stubbed or unavailable
    }
    action()
}

class SingleReplyResult(private val delegate: MethodChannel.Result) : MethodChannel.Result {
    private val replied = AtomicBoolean(false)

    override fun success(result: Any?) {
        if (replied.compareAndSet(false, true)) {
            runOnMainThread {
                delegate.success(result)
            }
        }
    }

    override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {
        if (replied.compareAndSet(false, true)) {
            runOnMainThread {
                delegate.error(errorCode, errorMessage, errorDetails)
            }
        }
    }

    override fun notImplemented() {
        if (replied.compareAndSet(false, true)) {
            runOnMainThread {
                delegate.notImplemented()
            }
        }
    }
}

object NativeOwnershipCoordinator : MethodChannel.MethodCallHandler {
    const val CHANNEL = "com.towmitra.driver/native_ownership_coordinator"
    const val PREFS_NAME = "towing_duty_ownership"
    const val KEY_OWNER_RECORD = "durable_duty_owner_record"
    const val KEY_WORKER_PAYLOAD = "duty_worker_payload"
    const val KEY_MONOTONIC_SEQUENCE = "monotonic_lifecycle_seq"
    const val KEY_OWNER_STATE = "durable_duty_owner_state"
    const val KEY_ACTIVE_TOKEN_EPOCH = "active_token_epoch"
    const val KEY_CALLBACK_HANDLE = "duty_service_callback_handle"
    const val KEY_RESTART_READINESS_GRANT = "duty_restart_readiness_grant"
    const val KEY_RESTART_LIFECYCLE = "duty_restart_lifecycle"

    const val LIFECYCLE_PERMIT_RESTART = "PERMIT_RESTART"
    const val LIFECYCLE_TERMINAL_REVOKED = "TERMINAL_REVOKED"

    const val STATE_STOPPED = "STOPPED"
    const val STATE_PENDING_START = "PENDING_START"
    const val STATE_ACTIVE = "ACTIVE"
    const val STATE_PENDING_STOP = "PENDING_STOP"
    const val STATE_FAILED_CLEANUP = "FAILED_CLEANUP"

    fun getRestartReadinessGrant(prefs: SharedPreferences): SessionToken? {
        val raw = prefs.getString(KEY_RESTART_READINESS_GRANT, null) ?: return null
        return try {
            val obj = JSONObject(raw)
            val uid = parseStrictString(obj.opt("uid")) ?: return null
            val sess = parseStrictString(obj.opt("sessionId")) ?: return null
            val gen = parseStrictInt(obj.opt("generation")) ?: return null
            val seq = parseStrictLong(obj.opt("lifecycleSeq")) ?: return null
            SessionToken(uid, sess, gen, seq)
        } catch (_: Throwable) {
            null
        }
    }

    fun setRestartReadinessGrant(prefs: SharedPreferences, token: SessionToken): Boolean {
        val injected = testCommitFailureInjector?.invoke("confirm_readiness") == true
        var success = false
        try {
            val grantJson = JSONObject()
                .put("uid", token.uid)
                .put("sessionId", token.sessionId)
                .put("generation", token.generation)
                .put("lifecycleSeq", token.lifecycleSeq)
                .toString()
            val editor = prefs.edit()
                .putString(KEY_RESTART_READINESS_GRANT, grantJson)
                .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_PERMIT_RESTART)
            success = if (!injected) {
                editor.commit()
            } else {
                try { editor.commit() } catch (_: Exception) {}
                false
            }
        } catch (_: Throwable) {
            success = false
        }
        if (!success) {
            try {
                prefs.edit()
                    .remove(KEY_RESTART_READINESS_GRANT)
                    .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
                    .apply()
            } catch (_: Throwable) {}
        }
        return success
    }

    fun clearRestartReadinessGrant(prefs: SharedPreferences): Boolean {
        val injected = testCommitFailureInjector?.invoke("revoke_readiness") == true
        return try {
            val editor = prefs.edit()
                .remove(KEY_RESTART_READINESS_GRANT)
                .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
            if (!injected) {
                editor.commit()
            } else {
                try { editor.commit() } catch (_: Exception) {}
                false
            }
        } catch (_: Throwable) {
            false
        }
    }

    private data class CleanupLease(val operationId: String, val owner: String?, val epoch: Long = activeExecutionEpoch)
    private val cleanupLeases = mutableMapOf<String, CleanupLease>()
    val ownershipLock = Any()
    private var appContext: Context? = null
    private var activeExecutionEpoch: Long = 0L

    // Controlled operation-entry test hooks for adversarial validation
    @Volatile
    var testHook: ((action: String, args: Map<String, Any?>?) -> Unit)? = null

    @Volatile
    var testCommitFailureInjector: ((operation: String) -> Boolean)? = null

    @Volatile
    var testNativeStopExceptionInjector: (() -> Exception)? = null

    @Volatile
    var testTokenRetrievalFailureInjector: (() -> Exception?)? = null

    val engineChannels: MutableMap<BinaryMessenger, MethodChannel> = Collections.synchronizedMap(mutableMapOf())
    val engineTokens: MutableMap<BinaryMessenger, SessionToken> = Collections.synchronizedMap(mutableMapOf())

    fun init(context: Context) {
        synchronized(ownershipLock) {
            if (appContext == null) {
                appContext = context.applicationContext
            }
        }
    }

    fun getAppContext(): Context? = appContext

    fun resetForTesting(context: Context? = null) {
        synchronized(ownershipLock) {
            appContext = context?.applicationContext ?: context
            activeExecutionEpoch = 0L
            cleanupLeases.clear()
            testHook = null
            testCommitFailureInjector = null
            testNativeStopExceptionInjector = null
            testTokenRetrievalFailureInjector = null
            for ((messenger, channel) in HashMap(engineChannels)) {
                try { channel.setMethodCallHandler(null) } catch (_: Throwable) {}
            }
            engineChannels.clear()
            engineTokens.clear()
            val wasBypass = DutyForegroundService.bypassAndroidSystemServicesForTesting
            val wasSync = DutyForegroundService.syncStartupForTesting
            DutyForegroundService.resetForTesting(context ?: appContext, DutyForegroundService.instance)
            DutyForegroundService.bypassAndroidSystemServicesForTesting = wasBypass
            DutyForegroundService.syncStartupForTesting = wasSync
        }
    }

    fun registerWith(context: Context, messenger: BinaryMessenger) {
        init(context)
        val channel = MethodChannel(messenger, CHANNEL)
        channel.setMethodCallHandler(this)
    }

    fun registerWithEngine(context: Context, messenger: BinaryMessenger, token: SessionToken) {
        init(context)
        val channel = MethodChannel(messenger, CHANNEL)
        engineChannels[messenger] = channel
        engineTokens[messenger] = token
        channel.setMethodCallHandler(object : MethodChannel.MethodCallHandler {
            override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
                when (call.method) {
                    "getAcquisitionToken" -> {
                        testTokenRetrievalFailureInjector?.let { injector ->
                            val ex = injector.invoke()
                            if (ex != null) {
                                result.success(null)
                                return
                            }
                        }
                        result.success(mapOf(
                            "uid" to token.uid,
                            "sessionId" to token.sessionId,
                            "generation" to token.generation,
                            "lifecycleSeq" to token.lifecycleSeq
                        ))
                    }
                    "reportWorkerBootstrapFailed" -> {
                        val diagError = validateBoundDiagnostics(call, token)
                        if (diagError != null) {
                            result.success(mapOf(
                                "success" to false,
                                "cleaned" to false,
                                "cleanupRequired" to false,
                                "reason" to diagError,
                                "boundToken" to mapOf(
                                    "uid" to token.uid,
                                    "sessionId" to token.sessionId,
                                    "generation" to token.generation,
                                    "lifecycleSeq" to token.lifecycleSeq
                                )
                            ))
                            return
                        }

                        val cleanupResult = DutyForegroundService.handleWorkerBootstrapFailure(token)
                        result.success(cleanupResult)
                    }
                    "confirmWorkerBootstrapReadiness" -> {
                        val diagError = validateBoundDiagnostics(call, token)
                        if (diagError != null) {
                            result.success(mapOf(
                                "success" to false,
                                "granted" to false,
                                "reason" to diagError
                            ))
                            return
                        }

                        val readinessResult = DutyForegroundService.confirmWorkerReadiness(token)
                        result.success(readinessResult)
                    }
                    else -> this@NativeOwnershipCoordinator.onMethodCall(call, result)
                }
            }
        })
    }

    fun unregisterEngine(messenger: BinaryMessenger?) {
        if (messenger == null) return
        val channel = engineChannels.remove(messenger) ?: MethodChannel(messenger, CHANNEL)
        try {
            channel.setMethodCallHandler(null)
        } catch (_: Throwable) {}
        engineTokens.remove(messenger)
    }

    fun isEngineChannelRegistered(messenger: BinaryMessenger?): Boolean {
        if (messenger == null) return false
        return engineChannels.containsKey(messenger)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val context = appContext
        if (context == null) {
            result.error("ILLEGAL_STATE", "NativeOwnershipCoordinator context not initialized", null)
            return
        }

        when (call.method) {
            "getAcquisitionToken" -> {
                // Global channel has no engine binding; strictly return null to prevent borrowing mutable owner!
                result.success(null)
            }
            "reportWorkerBootstrapFailed" -> {
                // FAIL CLOSED: Global channel has ZERO authority to perform worker bootstrap cleanup!
                // Caller-supplied tuple completeness NEVER creates cleanup authority.
                result.success(mapOf(
                    "success" to false,
                    "cleaned" to false,
                    "cleanupRequired" to false,
                    "reason" to "unbound_cleanup_rejected"
                ))
            }
            "confirmWorkerBootstrapReadiness" -> {
                // Global channel has ZERO authority to confirm worker readiness!
                result.success(mapOf(
                    "success" to false,
                    "reason" to "unbound_readiness_rejected"
                ))
            }
            "beginCleanupAcquisition" -> {
                val operationId = parseStrictString(call.argument<Any>("operationId"))
                val uid = parseStrictString(call.argument<Any>("expectedUid"))
                if (operationId == null || uid == null) {
                    result.error("INVALID_ARGUMENT", "Operation and UID required", null)
                    return
                }
                // Linearization shares exactly the START/STOP ownership domain.
                synchronized(ownershipLock) {
                    handleGetDurableOwner(context, object : MethodChannel.Result {
                        override fun success(value: Any?) {
                            val raw = value as String?
                            if (raw != null && JSONObject(raw).getString("uid") != uid) {
                                result.error("UID_CONFLICT", "Native owner belongs to another UID", null)
                                return
                            }
                            val token = java.util.UUID.randomUUID().toString()
                            cleanupLeases[token] = CleanupLease(operationId, raw, activeExecutionEpoch)
                            result.success(mapOf("token" to token, "operationId" to operationId,
                                "captured" to (raw != null), "owner" to raw, "epoch" to activeExecutionEpoch))
                        }
                        override fun error(code: String, message: String?, details: Any?) =
                            result.error(code, message, details)
                        override fun notImplemented() = result.notImplemented()
                    }, observational = false)
                }
            }
            "resolveCleanupAcquisition", "validateCleanupAcquisition", "releaseCleanupAcquisition" -> {
                synchronized(ownershipLock) {
                    val token = call.argument<String>("token")
                    val operationId = call.argument<String>("operationId")
                    val lease = cleanupLeases[token]
                    val matches = lease != null && lease.operationId == operationId
                    val valid = matches && lease.epoch == activeExecutionEpoch
                    if (matches && call.method == "releaseCleanupAcquisition") cleanupLeases.remove(token)
                    if (call.method == "resolveCleanupAcquisition") {
                        result.success(if (matches) mapOf("token" to token, "operationId" to operationId,
                            "captured" to (lease.owner != null), "owner" to lease.owner, "epoch" to lease.epoch) else null)
                    } else if (call.method == "validateCleanupAcquisition") {
                        result.success(valid)
                    } else {
                        result.success(matches)
                    }
                }
            }
            "getDurableOwner" -> handleGetDurableOwner(context, result)
            "getWorkerPayload" -> handleGetWorkerPayload(context, result)
            "getMonotonicSequence" -> handleGetMonotonicSequence(context, result)
            "isServiceRunning" -> result.success(DutyForegroundService.isHealthyRunning())
            "atomicStartService" -> handleAtomicStartService(context, call, result)
            "atomicStopService" -> handleAtomicStopService(context, call, result)
            "atomicRemoveOwner" -> handleAtomicRemoveOwner(context, call, result)
            else -> result.notImplemented()
        }
    }

    private fun handleGetDurableOwner(context: Context, result: MethodChannel.Result, observational: Boolean = true) {
        synchronized(ownershipLock) {
            if (observational) testHook?.invoke("before_get_owner", null)
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val rawJson = prefs.getString(KEY_OWNER_RECORD, null)
            if (rawJson == null || rawJson.trim().isEmpty()) {
                result.success(null)
                return
            }

            try {
                val obj = JSONObject(rawJson)
                val sessionId = parseStrictString(obj.opt("sessionId"))
                val uid = parseStrictString(obj.opt("uid"))
                val generation = parseStrictInt(obj.opt("generation"))
                val lifecycleSeq = parseStrictLong(obj.opt("lifecycleSeq"))
                val state = parseStrictString(obj.opt("state"))
                val startedAt = parseStrictString(obj.opt("startedAt"))

                if (sessionId == null || uid == null || generation == null || lifecycleSeq == null ||
                    state == null || startedAt == null) {
                    result.error("CORRUPT_RECORD", "Durable owner record contains invalid fields", null)
                    return
                }

                if (state != STATE_PENDING_START && state != STATE_ACTIVE &&
                    state != STATE_PENDING_STOP && state != STATE_STOPPED &&
                    state != STATE_FAILED_CLEANUP) {
                    result.error("CORRUPT_RECORD", "Durable owner record contains invalid state: $state", null)
                    return
                }

                if (obj.has("executionEpoch")) {
                    val epoch = parseStrictLong(obj.opt("executionEpoch"))
                    if (epoch == null) {
                        result.error("CORRUPT_RECORD", "Durable owner record contains invalid executionEpoch", null)
                        return
                    }
                }

                // Cross-check with worker payload if present
                val workerPayloadJson = prefs.getString(KEY_WORKER_PAYLOAD, null)
                if (workerPayloadJson != null && workerPayloadJson.trim().isNotEmpty()) {
                    val pObj = JSONObject(workerPayloadJson)
                    val pUid = parseStrictString(pObj.opt("uid"))
                    val pSessionId = parseStrictString(pObj.opt("sessionId"))
                    val pGen = parseStrictInt(pObj.opt("generation"))
                    val pSeq = parseStrictLong(pObj.opt("lifecycleSeq"))
                    if (pUid != uid || pSessionId != sessionId || pGen != generation || pSeq != lifecycleSeq) {
                        result.error("CORRUPT_RECORD", "Contradictory owner and worker payload metadata", null)
                        return
                    }
                }

                // Cross-check with monotonic sequence counter if present and active
                val monotonicSeq = prefs.getLong(KEY_MONOTONIC_SEQUENCE, -1L)
                if (state == STATE_ACTIVE && monotonicSeq != -1L && monotonicSeq != lifecycleSeq) {
                    result.error("CORRUPT_RECORD", "Contradictory owner and monotonic sequence metadata", null)
                    return
                }

                result.success(rawJson)
            } catch (e: Exception) {
                result.error("CORRUPT_RECORD", "Failed to parse durable owner record: ${e.message}", null)
            }
        }
    }

    private fun handleGetWorkerPayload(context: Context, result: MethodChannel.Result) {
        synchronized(ownershipLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val payload = prefs.getString(KEY_WORKER_PAYLOAD, null)
            result.success(payload)
        }
    }

    private fun handleGetMonotonicSequence(context: Context, result: MethodChannel.Result) {
        synchronized(ownershipLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val seq = prefs.getLong(KEY_MONOTONIC_SEQUENCE, 0L)
            result.success(seq)
        }
    }

    fun parseStrictInt(value: Any?): Int? {
        if (value == null) return null
        if (value is String || value is Boolean) return null
        if (value !is Number) return null
        if (value is java.math.BigDecimal) {
            if (value.scale() > 0) return null
            return try {
                val i = value.intValueExact()
                if (i >= 0) i else null
            } catch (_: ArithmeticException) { null }
        }
        if (value is java.math.BigInteger) {
            return try {
                val i = value.intValueExact()
                if (i >= 0) i else null
            } catch (_: ArithmeticException) { null }
        }
        if (value is Double) {
            if (value.isNaN() || value.isInfinite()) return null
            if (value != Math.floor(value)) return null
            if (value < 0.0 || value >= 2147483648.0) return null
            val i = value.toInt()
            if (i.toDouble() != value || i < 0) return null
            return i
        }
        if (value is Float) {
            if (value.isNaN() || value.isInfinite()) return null
            val d = value.toDouble()
            if (d != Math.floor(d)) return null
            if (d < 0.0 || d >= 2147483648.0 || value >= 2147483648f) return null
            val i = value.toInt()
            if (i.toFloat() != value || i < 0) return null
            return i
        }
        if (value is Long) {
            if (value < 0L || value > Int.MAX_VALUE.toLong()) return null
            return value.toInt()
        }
        if (value is Int) {
            if (value < 0) return null
            return value
        }
        if (value is Short) {
            if (value < 0) return null
            return value.toInt()
        }
        if (value is Byte) {
            if (value < 0) return null
            return value.toInt()
        }
        return null
    }

    fun parseStrictLong(value: Any?): Long? {
        if (value == null) return null
        if (value is String || value is Boolean) return null
        if (value !is Number) return null
        if (value is java.math.BigDecimal) {
            if (value.scale() > 0) return null
            return try {
                val l = value.longValueExact()
                if (l > 0L) l else null
            } catch (_: ArithmeticException) { null }
        }
        if (value is java.math.BigInteger) {
            return try {
                val l = value.longValueExact()
                if (l > 0L) l else null
            } catch (_: ArithmeticException) { null }
        }
        if (value is Double) {
            if (value.isNaN() || value.isInfinite()) return null
            if (value != Math.floor(value)) return null
            if (value <= 0.0 || value >= 9223372036854775808.0) return null
            val l = value.toLong()
            if (l <= 0L || l == Long.MAX_VALUE && value >= 9223372036854775808.0) return null
            if (l.toDouble() != value) return null
            return l
        }
        if (value is Float) {
            if (value.isNaN() || value.isInfinite()) return null
            val d = value.toDouble()
            if (d != Math.floor(d)) return null
            if (d <= 0.0 || d >= 9223372036854775808.0 || value >= 9223372036854775808f) return null
            val l = value.toLong()
            if (l <= 0L || l == Long.MAX_VALUE && d >= 9223372036854775808.0) return null
            if (l.toFloat() != value) return null
            return l
        }
        if (value is Long) {
            if (value <= 0L) return null
            return value
        }
        if (value is Int) {
            if (value <= 0) return null
            return value.toLong()
        }
        if (value is Short) {
            if (value <= 0) return null
            return value.toLong()
        }
        if (value is Byte) {
            if (value <= 0) return null
            return value.toLong()
        }
        return null
    }

    fun parseStrictCallbackHandle(value: Any?): Long? {
        if (value == null) return null
        if (value is String || value is Boolean) return null
        if (value is java.math.BigInteger) return null
        if (value is java.math.BigDecimal) return null
        if (value is Double || value is Float) return null
        if (value !is Number) return null
        if (value is Long) {
            return if (value != 0L) value else null
        }
        if (value is Int) {
            return if (value != 0) value.toLong() else null
        }
        if (value is Short) {
            return if (value.toInt() != 0) value.toLong() else null
        }
        if (value is Byte) {
            return if (value.toInt() != 0) value.toLong() else null
        }
        return null
    }

    fun parseStrictString(value: Any?): String? {
        if (value == null || value !is String) return null
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        return trimmed
    }

    fun validateBoundDiagnostics(call: MethodCall, token: SessionToken): String? {
        val args = call.arguments as? Map<*, *> ?: return null
        val hasUid = args.containsKey("uid")
        val hasSessionId = args.containsKey("sessionId")
        val hasGen = args.containsKey("generation")
        val hasSeq = args.containsKey("lifecycleSeq")

        if (!hasUid && !hasSessionId && !hasGen && !hasSeq) {
            return null
        }

        if (!hasUid || !hasSessionId || !hasGen || !hasSeq) {
            return "diagnostic_tuple_invalid"
        }

        val rawUid = args["uid"]
        val rawSessionId = args["sessionId"]
        val rawGen = args["generation"]
        val rawSeq = args["lifecycleSeq"]

        val parsedUid = parseStrictString(rawUid)
        val parsedSessionId = parseStrictString(rawSessionId)
        val parsedGen = parseStrictInt(rawGen)
        val parsedSeq = parseStrictLong(rawSeq)

        if (parsedUid == null || parsedSessionId == null || parsedGen == null || parsedSeq == null) {
            return "diagnostic_tuple_invalid"
        }

        if (parsedUid != token.uid ||
            parsedSessionId != token.sessionId ||
            parsedGen != token.generation ||
            parsedSeq != token.lifecycleSeq) {
            return "diagnostic_tuple_mismatch"
        }

        return null
    }

    private fun handleAtomicStartService(context: Context, call: MethodCall, rawResult: MethodChannel.Result) {
        val result = SingleReplyResult(rawResult)
        val sessionId = parseStrictString(call.argument<Any>("sessionId"))
        val uid = parseStrictString(call.argument<Any>("uid"))
        val dutyGeneration = parseStrictInt(call.argument<Any>("dutyGeneration"))
        val lifecycleSeq = parseStrictLong(call.argument<Any>("lifecycleSeq"))
        val sessionPayloadJson = parseStrictString(call.argument<Any>("sessionPayloadJson"))
        val foregroundTaskOptionsMap = call.argument<Map<*, *>>("foregroundTaskOptionsMap")
        val notificationTitle = call.argument<String>("notificationTitle")
        val notificationText = call.argument<String>("notificationText")

        if (sessionId == null || uid == null ||
            dutyGeneration == null || lifecycleSeq == null ||
            sessionPayloadJson == null) {
            result.error("INVALID_ARGUMENT", "Valid sessionId, uid, dutyGeneration, lifecycleSeq, and sessionPayloadJson are required", null)
            return
        }

        // Validate real worker callback handle
        val rawCallbackHandle = foregroundTaskOptionsMap?.get("callbackHandle")
        val callbackHandle = parseStrictCallbackHandle(rawCallbackHandle)
        if (callbackHandle == null) {
            result.error("INVALID_ARGUMENT", "Valid callbackHandle is required in foregroundTaskOptionsMap", null)
            return
        }

        var epoch: Long = 0L

        synchronized(ownershipLock) {
            testHook?.invoke("before_atomic_start", mapOf("sessionId" to sessionId, "lifecycleSeq" to lifecycleSeq))
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

            // Monotonic sequence validation
            val currentMonotonicSeq = prefs.getLong(KEY_MONOTONIC_SEQUENCE, 0L)
            val existingOwnerJson = prefs.getString(KEY_OWNER_RECORD, null)
            var existingOwnerSeq = 0L
            if (existingOwnerJson != null) {
                try {
                    val existingObj = JSONObject(existingOwnerJson)
                    existingOwnerSeq = parseStrictLong(existingObj.opt("lifecycleSeq")) ?: 0L
                } catch (_: Exception) {}
            }
            val maxExistingSeq = maxOf(currentMonotonicSeq, existingOwnerSeq)

            if (lifecycleSeq <= maxExistingSeq) {
                result.success(mapOf(
                    "success" to false,
                    "reason" to "superseded_sequence",
                    "currentSeq" to maxExistingSeq
                ))
                return
            }

            // Parse and strictly validate agreement between arguments and payload JSON
            val enrichedOwnerJson: String
            try {
                val payloadObj = JSONObject(sessionPayloadJson)
                val payloadSessionId = parseStrictString(payloadObj.opt("sessionId"))
                val payloadUid = parseStrictString(payloadObj.opt("uid"))
                val payloadGen = parseStrictInt(payloadObj.opt("generation"))
                val payloadSeq = parseStrictLong(payloadObj.opt("lifecycleSeq"))

                if (payloadSessionId == null || payloadUid == null || payloadGen == null || payloadSeq == null ||
                    payloadSessionId != sessionId || payloadUid != uid ||
                    payloadGen != dutyGeneration || payloadSeq != lifecycleSeq) {
                    result.error("INVALID_PAYLOAD", "Payload epoch fields disagree with command arguments or contain invalid values", null)
                    return
                }

                activeExecutionEpoch++
                epoch = activeExecutionEpoch
                payloadObj.put("state", STATE_PENDING_START)
                payloadObj.put("executionEpoch", epoch)
                enrichedOwnerJson = payloadObj.toString()
            } catch (e: Exception) {
                result.error("INVALID_PAYLOAD", "Malformed payload JSON: ${e.message}", null)
                return
            }

            // Snapshot previous state before editing to enable atomic rollback
            val prevOwnerRecord = prefs.getString(KEY_OWNER_RECORD, null)
            val prevWorkerPayload = prefs.getString(KEY_WORKER_PAYLOAD, null)
            val prevMonotonicSeq = if (prefs.contains(KEY_MONOTONIC_SEQUENCE)) prefs.getLong(KEY_MONOTONIC_SEQUENCE, 0L) else null
            val prevOwnerState = prefs.getString(KEY_OWNER_STATE, null)
            val prevActiveEpoch = if (prefs.contains(KEY_ACTIVE_TOKEN_EPOCH)) prefs.getLong(KEY_ACTIVE_TOKEN_EPOCH, 0L) else null
            val prevCallbackHandle = if (prefs.contains(KEY_CALLBACK_HANDLE)) prefs.getLong(KEY_CALLBACK_HANDLE, 0L) else null
            val preMutationEpoch = activeExecutionEpoch

            // Atomic persistence of owner record, worker payload, and monotonic sequence
            var committed = false
            var commitException: Exception? = null
            try {
                val editor = prefs.edit()
                    .putString(KEY_OWNER_RECORD, enrichedOwnerJson)
                    .putString(KEY_WORKER_PAYLOAD, sessionPayloadJson)
                    .putLong(KEY_MONOTONIC_SEQUENCE, lifecycleSeq)
                    .putString(KEY_OWNER_STATE, STATE_PENDING_START)
                    .putLong(KEY_ACTIVE_TOKEN_EPOCH, epoch)
                    .putLong(KEY_CALLBACK_HANDLE, callbackHandle)
                    .remove(KEY_RESTART_READINESS_GRANT)
                    .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)

                if (testCommitFailureInjector?.invoke("start_payload") == true ||
                    testCommitFailureInjector?.invoke("start_commit") == true) {
                    try { editor.commit() } catch (_: Exception) {}
                    committed = false
                } else {
                    committed = editor.commit()
                }
            } catch (e: Exception) {
                committed = false
                commitException = e
            }

            if (!committed || commitException != null) {
                // Revert in-memory mutations to snapshot so no uncommitted state is retained
                activeExecutionEpoch = preMutationEpoch
                try {
                    val revertEditor = prefs.edit()
                    if (prevOwnerRecord != null) revertEditor.putString(KEY_OWNER_RECORD, prevOwnerRecord) else revertEditor.remove(KEY_OWNER_RECORD)
                    if (prevWorkerPayload != null) revertEditor.putString(KEY_WORKER_PAYLOAD, prevWorkerPayload) else revertEditor.remove(KEY_WORKER_PAYLOAD)
                    if (prevMonotonicSeq != null) revertEditor.putLong(KEY_MONOTONIC_SEQUENCE, prevMonotonicSeq) else revertEditor.remove(KEY_MONOTONIC_SEQUENCE)
                    if (prevOwnerState != null) revertEditor.putString(KEY_OWNER_STATE, prevOwnerState) else revertEditor.remove(KEY_OWNER_STATE)
                    if (prevActiveEpoch != null) revertEditor.putLong(KEY_ACTIVE_TOKEN_EPOCH, prevActiveEpoch) else revertEditor.remove(KEY_ACTIVE_TOKEN_EPOCH)
                    if (prevCallbackHandle != null) revertEditor.putLong(KEY_CALLBACK_HANDLE, prevCallbackHandle) else revertEditor.remove(KEY_CALLBACK_HANDLE)
                    revertEditor.apply()
                    revertEditor.commit()
                } catch (_: Exception) {}

                // Rollback partial persistence ONLY if owner is still this epoch
                safeRollbackStart(prefs, uid, sessionId, dutyGeneration, lifecycleSeq)
                result.success(mapOf(
                    "success" to false,
                    "reason" to "commit_failed"
                ))
                return
            }

            testHook?.invoke("after_persistence_before_service_start", mapOf("sessionId" to sessionId))

            // Re-verify owner was not displaced during test hooks
            val postHookJson = prefs.getString(KEY_OWNER_RECORD, null)
            if (postHookJson != enrichedOwnerJson) {
                result.success(mapOf(
                    "success" to false,
                    "reason" to "ownership_transferred_before_start"
                ))
                return
            }
        }

        // Route execution to dedicated DutyForegroundService with immutable epoch token
        if (DutyForegroundService.holdPendingStartsForTesting) {
            try {
                DutyForegroundService.startServiceWithToken(
                    context = context,
                    uid = uid,
                    sessionId = sessionId,
                    generation = dutyGeneration,
                    lifecycleSeq = lifecycleSeq,
                    notificationTitle = notificationTitle,
                    notificationText = notificationText,
                    callbackHandle = callbackHandle
                )
                result.success(mapOf(
                    "success" to true,
                    "active" to false,
                    "sessionId" to sessionId,
                    "lifecycleSeq" to lifecycleSeq,
                    "generation" to dutyGeneration,
                    "executionEpoch" to epoch,
                    "state" to STATE_PENDING_START
                ))
            } catch (e: Exception) {
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                safeRollbackStart(prefs, uid, sessionId, dutyGeneration, lifecycleSeq)
                result.error("SERVICE_START_FAILED", "Failed to start native service: ${e.message}", null)
            }
            return
        }

        try {
            DutyForegroundService.startServiceWithToken(
                context = context,
                uid = uid,
                sessionId = sessionId,
                generation = dutyGeneration,
                lifecycleSeq = lifecycleSeq,
                notificationTitle = notificationTitle,
                notificationText = notificationText,
                callbackHandle = callbackHandle
            ) { success, active, reason, error ->
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                if (success && active) {
                    result.success(mapOf(
                        "success" to true,
                        "active" to true,
                        "sessionId" to sessionId,
                        "lifecycleSeq" to lifecycleSeq,
                        "generation" to dutyGeneration,
                        "executionEpoch" to epoch,
                        "state" to STATE_ACTIVE
                    ))
                } else {
                    safeRollbackStart(prefs, uid, sessionId, dutyGeneration, lifecycleSeq)
                    result.success(mapOf(
                        "success" to false,
                        "active" to false,
                        "reason" to (reason ?: "active_transition_failed"),
                        "error" to error,
                        "sessionId" to sessionId,
                        "lifecycleSeq" to lifecycleSeq,
                        "generation" to dutyGeneration
                    ))
                }
            }
        } catch (e: Exception) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            safeRollbackStart(prefs, uid, sessionId, dutyGeneration, lifecycleSeq)
            result.error("SERVICE_START_FAILED", "Failed to start native service: ${e.message}", null)
        }
    }

    fun safeRollbackStart(
        prefs: SharedPreferences,
        expectedUid: String,
        expectedSessionId: String,
        expectedGeneration: Int,
        expectedLifecycleSeq: Long
    ): Boolean {
        synchronized(ownershipLock) {
            DutyForegroundService.revokeStartAuthorization(
                SessionToken(expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq)
            )
            val currentJson = prefs.getString(KEY_OWNER_RECORD, null) ?: return true
            return try {
                val obj = JSONObject(currentJson)
                val curUid = parseStrictString(obj.opt("uid"))
                val curSessionId = parseStrictString(obj.opt("sessionId"))
                val curGen = parseStrictInt(obj.opt("generation"))
                val curSeq = parseStrictLong(obj.opt("lifecycleSeq"))

                // Compare complete immutable owner epoch!
                if (curUid == expectedUid && curSessionId == expectedSessionId &&
                    curGen == expectedGeneration && curSeq == expectedLifecycleSeq) {

                    val rollbackInjected = testCommitFailureInjector?.invoke("rollback") == true
                    // Hooks and preference listeners can reenter ownership operations.
                    // The matched snapshot must still own storage at the write boundary.
                    if (prefs.getString(KEY_OWNER_RECORD, null) != currentJson) return true
                    var committed = false
                    if (!rollbackInjected) {
                        try {
                            val editor = prefs.edit()
                                .remove(KEY_OWNER_RECORD)
                                .remove(KEY_WORKER_PAYLOAD)
                                .remove(KEY_ACTIVE_TOKEN_EPOCH)
                                .remove(KEY_CALLBACK_HANDLE)
                                .remove(KEY_RESTART_READINESS_GRANT)
                                .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
                                .putString(KEY_OWNER_STATE, STATE_STOPPED)
                            committed = editor.commit()
                        } catch (_: Exception) {
                            committed = false
                        }
                    }

                    if (!committed) {
                        // Failed rollback commit must leave an explicit recoverable failure state!
                        obj.put("state", STATE_FAILED_CLEANUP)
                        val failureStateInjected = testCommitFailureInjector?.invoke("failure_state") == true
                        val remainingJson = prefs.getString(KEY_OWNER_RECORD, null)
                        if (remainingJson != null && remainingJson != currentJson) return true
                        try {
                            val failEditor = prefs.edit()
                                .putString(KEY_OWNER_RECORD, obj.toString())
                                .putString(KEY_OWNER_STATE, STATE_FAILED_CLEANUP)
                                .remove(KEY_RESTART_READINESS_GRANT)
                                .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
                            if (failureStateInjected) {
                                failEditor.apply()
                            } else {
                                failEditor.commit()
                            }
                        } catch (_: Exception) {}
                        false
                    } else {
                        true
                    }
                } else {
                    // Owner or sequence advanced (e.g. S2 registered): never erase replacement owner
                    true
                }
            } catch (_: Exception) {
                false
            }
        }
    }

    private fun handleAtomicStopService(context: Context, call: MethodCall, rawResult: MethodChannel.Result) {
        val result = SingleReplyResult(rawResult)
        val expectedUid = parseStrictString(call.argument<Any>("expectedUid"))
        val expectedSessionId = parseStrictString(call.argument<Any>("expectedSessionId"))
        val expectedLifecycleSeq = parseStrictLong(call.argument<Any>("expectedLifecycleSeq"))
        val expectedGeneration = parseStrictInt(call.argument<Any>("expectedGeneration"))

        if (expectedUid == null || expectedSessionId == null ||
            expectedLifecycleSeq == null || expectedGeneration == null) {
            result.error("INVALID_ARGUMENT", "expectedUid, expectedSessionId, expectedLifecycleSeq, and expectedGeneration are all required", null)
            return
        }

        synchronized(ownershipLock) {
            val cleanupToken = call.argument<String>("cleanupToken")
            if (cleanupToken != null) {
                val lease = cleanupLeases[cleanupToken]
                val captured = lease?.owner?.let { JSONObject(it) }
                if (lease == null || lease.operationId != call.argument<String>("cleanupOperationId") ||
                    captured == null || captured.optString("uid") != expectedUid ||
                    captured.optString("sessionId") != expectedSessionId ||
                    parseStrictInt(captured.opt("generation")) != expectedGeneration ||
                    parseStrictLong(captured.opt("lifecycleSeq")) != expectedLifecycleSeq) {
                    result.error("INVALID_CLEANUP_ACQUISITION", "STOP must use its immutable acquisition", null)
                    return
                }
            }

            DutyForegroundService.revokeStartAuthorization(
                SessionToken(expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq)
            )
            testHook?.invoke("before_atomic_stop", mapOf("expectedUid" to expectedUid, "expectedSessionId" to expectedSessionId, "expectedLifecycleSeq" to expectedLifecycleSeq))
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val currentJson = prefs.getString(KEY_OWNER_RECORD, null)

            if (currentJson == null || currentJson.trim().isEmpty()) {
                if (DutyForegroundService.isRunning) {
                    DutyForegroundService.stopServiceWithToken(
                        context = context,
                        expectedUid = expectedUid,
                        expectedSessionId = expectedSessionId,
                        expectedGeneration = expectedGeneration,
                        expectedLifecycleSeq = expectedLifecycleSeq
                    ) { success, stopped, reason, error ->
                        if (error != null) {
                            result.error("NATIVE_STOP_FAILED", error, null)
                        } else {
                            result.success(mapOf(
                                "success" to success,
                                "stopped" to stopped,
                                "reason" to (reason ?: "no_active_owner")
                            ))
                        }
                    }
                } else {
                    result.success(mapOf(
                        "success" to true,
                        "stopped" to false,
                        "reason" to "no_active_owner"
                    ))
                }
                return
            }

            val currentObj = try {
                JSONObject(currentJson)
            } catch (e: Exception) {
                result.error("CORRUPT_RECORD", "Corrupt owner record during stop: ${e.message}", null)
                return
            }

            val currentUid = parseStrictString(currentObj.opt("uid"))
            val currentSessionId = parseStrictString(currentObj.opt("sessionId"))
            val currentSeq = parseStrictLong(currentObj.opt("lifecycleSeq"))
            val currentGeneration = parseStrictInt(currentObj.opt("generation"))

            if (currentUid == null || currentSessionId == null || currentSeq == null || currentGeneration == null) {
                result.error("CORRUPT_RECORD", "Corrupt owner record during stop: invalid epoch fields", null)
                return
            }

            // Fence 0: UID Check
            if (currentUid != expectedUid) {
                result.success(mapOf(
                    "success" to false,
                    "stopped" to false,
                    "reason" to "uid_mismatch",
                    "currentUid" to currentUid,
                    "currentSessionId" to currentSessionId,
                    "currentSeq" to currentSeq
                ))
                return
            }

            // Fence 1: Session ID Check
            if (currentSessionId != expectedSessionId) {
                val priorToken = SessionToken(expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq)
                val service = DutyForegroundService.instance
                if (service != null && service.hasBindingForToken(priorToken)) {
                    service.executeEffectiveTeardown(priorToken) { success, error ->
                        if (error != null || !success) {
                            result.error("NATIVE_STOP_FAILED", error ?: "Prior session stop failed", null)
                        } else {
                            result.success(mapOf(
                                "success" to true,
                                "stopped" to true,
                                "reason" to "prior_session_cleaned_up"
                            ))
                        }
                    }
                    return
                }

                result.success(mapOf(
                    "success" to false,
                    "stopped" to false,
                    "reason" to "ownership_transferred",
                    "currentSessionId" to currentSessionId,
                    "currentSeq" to currentSeq
                ))
                return
            }

            // Fence 2: Generation Check (strictly required)
            if (currentGeneration != expectedGeneration) {
                result.success(mapOf(
                    "success" to false,
                    "stopped" to false,
                    "reason" to "generation_mismatch",
                    "currentSessionId" to currentSessionId,
                    "currentGeneration" to currentGeneration,
                    "currentSeq" to currentSeq
                ))
                return
            }

            // Fence 3: Sequence Check
            if (currentSeq != expectedLifecycleSeq) {
                result.success(mapOf(
                    "success" to false,
                    "stopped" to false,
                    "reason" to "sequence_mismatch",
                    "currentSessionId" to currentSessionId,
                    "currentSeq" to currentSeq
                ))
                return
            }

            testHook?.invoke("during_stop_before_removal", mapOf("sessionId" to expectedSessionId))

            // Re-verify after test hook
            val postHookJson = prefs.getString(KEY_OWNER_RECORD, null)
            if (postHookJson != currentJson) {
                result.success(mapOf(
                    "success" to false,
                    "stopped" to false,
                    "reason" to "ownership_transferred",
                    "currentSeq" to currentSeq
                ))
                return
            }

            val savedPayload = prefs.getString(KEY_WORKER_PAYLOAD, null)

            // Test hook: simulated native stop exception
            if (testNativeStopExceptionInjector != null) {
                markFailedCleanup(prefs, currentObj, savedPayload)
                val ex = testNativeStopExceptionInjector!!.invoke()
                result.error("NATIVE_STOP_FAILED", ex.message, null)
                return
            }

            // Stop foreground service effectively with immutable token check
            DutyForegroundService.stopServiceWithToken(
                context = context,
                expectedUid = expectedUid,
                expectedSessionId = expectedSessionId,
                expectedGeneration = expectedGeneration,
                expectedLifecycleSeq = expectedLifecycleSeq
            ) { success, stopped, reason, error ->
                synchronized(ownershipLock) {
                    if (error != null || !success) {
                        markFailedCleanup(prefs, currentObj, savedPayload)
                        result.error("NATIVE_STOP_FAILED", error ?: "Native service stop failed", null)
                        return@stopServiceWithToken
                    }

                    // Check if ownership transferred in interim (e.g. S2 arrived while S1 was stopping)
                    val currentLatestOwnerJson = prefs.getString(KEY_OWNER_RECORD, null)
                    if (currentLatestOwnerJson != null) {
                        try {
                            val latestObj = JSONObject(currentLatestOwnerJson)
                            if (latestObj.optString("sessionId") != expectedSessionId ||
                                latestObj.optLong("lifecycleSeq") != expectedLifecycleSeq) {
                                // Newer session is now active owner, do NOT remove S2's record!
                                result.success(mapOf(
                                    "success" to true,
                                    "stopped" to true
                                ))
                                return@stopServiceWithToken
                            }
                        } catch (_: Exception) {}
                    }

                    // Teardown completed successfully; now remove owner record from disk
                    val removeEditor = prefs.edit()
                        .remove(KEY_OWNER_RECORD)
                        .remove(KEY_WORKER_PAYLOAD)
                        .remove(KEY_ACTIVE_TOKEN_EPOCH)
                        .remove(KEY_CALLBACK_HANDLE)
                        .remove(KEY_RESTART_READINESS_GRANT)
                        .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
                        .putString(KEY_OWNER_STATE, STATE_STOPPED)

                    var removeCommitted = false
                    var removeException: Exception? = null
                    try {
                        if (testCommitFailureInjector?.invoke("stop_removal") == true) {
                            try { removeEditor.commit() } catch (_: Exception) {}
                            removeCommitted = false
                        } else {
                            removeCommitted = removeEditor.commit()
                        }
                    } catch (e: Exception) {
                        removeCommitted = false
                        removeException = e
                    }

                    if (!removeCommitted || removeException != null) {
                        markFailedCleanup(prefs, currentObj, savedPayload)
                        result.success(mapOf(
                            "success" to false,
                            "stopped" to false,
                            "reason" to "commit_failed"
                        ))
                        return@stopServiceWithToken
                    }

                    result.success(mapOf(
                        "success" to true,
                        "stopped" to true
                    ))
                }
            }
        }
    }

    fun markFailedCleanup(prefs: SharedPreferences, ownerObj: JSONObject, savedPayload: String? = null) {
        try {
            val targetUid = parseStrictString(ownerObj.opt("uid")) ?: ""
            val targetSessionId = parseStrictString(ownerObj.opt("sessionId")) ?: ""
            val targetGen = parseStrictInt(ownerObj.opt("generation")) ?: -1
            val targetSeq = parseStrictLong(ownerObj.opt("lifecycleSeq")) ?: -1L

            val failedObj = JSONObject(ownerObj.toString())
            failedObj.put("state", STATE_FAILED_CLEANUP)
            val failedJson = failedObj.toString()

            val payloadToKeep = savedPayload ?: prefs.getString(KEY_WORKER_PAYLOAD, null)

            // Storage fence: verify storage owner record (if still present) still matches this token before marking failure!
            val currentJson = prefs.getString(KEY_OWNER_RECORD, null)
            if (currentJson != null && currentJson.isNotBlank()) {
                val currentObj = JSONObject(currentJson)
                val currentUid = parseStrictString(currentObj.opt("uid"))
                val currentSessionId = parseStrictString(currentObj.opt("sessionId"))
                val currentGen = parseStrictInt(currentObj.opt("generation"))
                val currentSeq = parseStrictLong(currentObj.opt("lifecycleSeq"))

                if (currentUid != targetUid ||
                    currentSessionId != targetSessionId ||
                    currentGen != targetGen ||
                    currentSeq != targetSeq) {
                    // Ownership already transferred to someone else (e.g. S2)!
                    // Do NOT overwrite S2 with failed cleanup!
                    return
                }
            }

            val editor = prefs.edit()
                .putString(KEY_OWNER_RECORD, failedJson)
                .putString(KEY_OWNER_STATE, STATE_FAILED_CLEANUP)
                .remove(KEY_RESTART_READINESS_GRANT)
                .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
            if (payloadToKeep != null) {
                editor.putString(KEY_WORKER_PAYLOAD, payloadToKeep)
            }
            try { editor.apply() } catch (_: Exception) {}
            try { editor.commit() } catch (_: Exception) {}
        } catch (_: Exception) {}
    }

    private fun handleAtomicRemoveOwner(context: Context, call: MethodCall, rawResult: MethodChannel.Result) {
        val result = SingleReplyResult(rawResult)
        val expectedUid = parseStrictString(call.argument<Any>("expectedUid"))
        val expectedSessionId = parseStrictString(call.argument<Any>("expectedSessionId"))
        val expectedLifecycleSeq = parseStrictLong(call.argument<Any>("expectedLifecycleSeq"))
        val expectedGeneration = parseStrictInt(call.argument<Any>("expectedGeneration"))

        if (expectedUid == null || expectedSessionId == null ||
            expectedLifecycleSeq == null || expectedGeneration == null) {
            result.error("INVALID_ARGUMENT", "expectedUid, expectedSessionId, expectedLifecycleSeq, and expectedGeneration are all required", null)
            return
        }

        synchronized(ownershipLock) {
            testHook?.invoke("before_atomic_remove", mapOf("expectedUid" to expectedUid, "expectedSessionId" to expectedSessionId, "expectedLifecycleSeq" to expectedLifecycleSeq))
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val currentJson = prefs.getString(KEY_OWNER_RECORD, null)
            if (currentJson == null) {
                result.success(mapOf("success" to true, "removed" to false, "reason" to "no_active_owner"))
                return
            }

            val currentObj = try {
                JSONObject(currentJson)
            } catch (e: Exception) {
                result.error("CORRUPT_RECORD", "Corrupt owner record during remove: ${e.message}", null)
                return
            }

            val currentUid = parseStrictString(currentObj.opt("uid"))
            val currentSessionId = parseStrictString(currentObj.opt("sessionId"))
            val currentSeq = parseStrictLong(currentObj.opt("lifecycleSeq"))
            val currentGeneration = parseStrictInt(currentObj.opt("generation"))

            if (currentUid == null || currentSessionId == null || currentSeq == null || currentGeneration == null) {
                result.error("CORRUPT_RECORD", "Corrupt owner record during remove: invalid epoch fields", null)
                return
            }

            if (currentUid != expectedUid || currentSessionId != expectedSessionId ||
                currentSeq != expectedLifecycleSeq || currentGeneration != expectedGeneration) {
                result.success(mapOf(
                    "success" to false,
                    "removed" to false,
                    "reason" to "ownership_transferred"
                ))
                return
            }

            val savedPayload = prefs.getString(KEY_WORKER_PAYLOAD, null)

            if (testCommitFailureInjector?.invoke("remove_owner") == true) {
                markFailedCleanup(prefs, currentObj, savedPayload)
                result.success(mapOf(
                    "success" to false,
                    "removed" to false,
                    "reason" to "commit_failed"
                ))
                return
            }

            var committed = false
            var removeException: Exception? = null
            try {
                val editor = prefs.edit()
                    .remove(KEY_OWNER_RECORD)
                    .remove(KEY_WORKER_PAYLOAD)
                    .remove(KEY_ACTIVE_TOKEN_EPOCH)
                    .remove(KEY_CALLBACK_HANDLE)
                    .remove(KEY_RESTART_READINESS_GRANT)
                    .putString(KEY_RESTART_LIFECYCLE, LIFECYCLE_TERMINAL_REVOKED)
                    .putString(KEY_OWNER_STATE, STATE_STOPPED)

                committed = editor.commit()
            } catch (e: Exception) {
                committed = false
                removeException = e
            }

            if (!committed || removeException != null) {
                markFailedCleanup(prefs, currentObj, savedPayload)
                result.success(mapOf(
                    "success" to false,
                    "removed" to false,
                    "reason" to "commit_failed"
                ))
                return
            }

            result.success(mapOf(
                "success" to true,
                "removed" to true
            ))
        }
    }
}
