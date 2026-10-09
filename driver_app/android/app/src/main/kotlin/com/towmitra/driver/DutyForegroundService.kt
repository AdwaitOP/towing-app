package com.towmitra.driver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.net.wifi.WifiManager
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.pravera.flutter_foreground_task.FlutterForegroundTaskLifecycleListener
import com.pravera.flutter_foreground_task.FlutterForegroundTaskStarter
import com.pravera.flutter_foreground_task.models.ForegroundServiceAction
import com.pravera.flutter_foreground_task.models.ForegroundServiceStatus
import com.pravera.flutter_foreground_task.models.ForegroundTaskData
import com.pravera.flutter_foreground_task.models.ForegroundTaskEventAction
import com.pravera.flutter_foreground_task.models.ForegroundTaskEventType
import com.pravera.flutter_foreground_task.service.ForegroundTask
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.FlutterCallbackInformation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Dedicated Intent subclass ensuring action and extras remain preserved and accessible
 * across both real Android runtime and local headless JVM test environments.
 */
open class DutyIntent : Intent {
    private val extrasMap = mutableMapOf<String, Any?>()
    private var customAction: String? = null

    constructor() : super()
    constructor(action: String) : super(action) { this.customAction = action }
    constructor(packageContext: Context, cls: Class<*>) : super(packageContext, cls)

    override fun getAction(): String? = customAction ?: super.getAction()
    override fun setAction(action: String?): Intent {
        this.customAction = action
        try { super.setAction(action) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: String?): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: Int): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: Long): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: Double): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: Float): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    override fun putExtra(name: String, value: Boolean): Intent {
        extrasMap[name] = value
        try { super.putExtra(name, value) } catch (_: Exception) {}
        return this
    }

    fun putExtraRaw(name: String, value: Any?): Intent {
        extrasMap[name] = value
        return this
    }

    fun getRawExtra(name: String): Any? {
        return if (extrasMap.containsKey(name)) extrasMap[name] else try {
            extras?.get(name)
        } catch (_: Exception) {
            null
        }
    }

    override fun getStringExtra(name: String): String? =
        (getRawExtra(name) as? String) ?: try { super.getStringExtra(name) } catch (_: Exception) { null }

    override fun getIntExtra(name: String, defaultValue: Int): Int =
        (getRawExtra(name) as? Int) ?: try { super.getIntExtra(name, defaultValue) } catch (_: Exception) { defaultValue }

    override fun getLongExtra(name: String, defaultValue: Long): Long =
        (getRawExtra(name) as? Long) ?: try { super.getLongExtra(name, defaultValue) } catch (_: Exception) { defaultValue }

    override fun getBooleanExtra(name: String, defaultValue: Boolean): Boolean =
        (getRawExtra(name) as? Boolean) ?: try { super.getBooleanExtra(name, defaultValue) } catch (_: Exception) { defaultValue }

    override fun hasExtra(name: String): Boolean =
        extrasMap.containsKey(name) || try { super.hasExtra(name) } catch (_: Exception) { false }
}

fun getRawExtra(intent: Intent, name: String): Any? {
    if (intent is DutyIntent) {
        return intent.getRawExtra(name)
    }
    return try {
        intent.extras?.get(name)
    } catch (_: Exception) {
        null
    }
}

/**
 * Immutable strictly-typed session token required for all destructive service operations.
 */
data class SessionToken(
    val uid: String,
    val sessionId: String,
    val generation: Int,
    val lifecycleSeq: Long
)

class DutyForegroundTask(
    private val context: Context,
    val flutterEngine: FlutterEngine,
    private val serviceStatus: ForegroundServiceStatus,
    private val taskData: ForegroundTaskData,
    private var taskEventAction: ForegroundTaskEventAction,
    private val taskLifecycleListener: FlutterForegroundTaskLifecycleListener,
) : MethodChannel.MethodCallHandler {
    companion object {
        private const val ACTION_TASK_START = "onStart"
        private const val ACTION_TASK_REPEAT_EVENT = "onRepeatEvent"
        private const val ACTION_TASK_DESTROY = "onDestroy"

        @JvmField
        @Volatile
        var testPreChannelRegInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostChannelRegInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testCallbackLookupFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testDartEntrypointFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testExecuteDartFailureInjector: (() -> Exception)? = null

        fun resetTestInjectors() {
            testPreChannelRegInjector = null
            testPostChannelRegInjector = null
            testCallbackLookupFailureInjector = null
            testDartEntrypointFailureInjector = null
            testExecuteDartFailureInjector = null
        }
    }

    private var backgroundChannel: MethodChannel? = null
    private var repeatTask: Job? = null
    private var isDestroyed: Boolean = false

    fun initialize() {
        try {
            testPreChannelRegInjector?.let { throw it.invoke() }

            val messenger = flutterEngine.dartExecutor.binaryMessenger
            val channel = MethodChannel(messenger, "flutter_foreground_task/background")
            backgroundChannel = channel
            channel.setMethodCallHandler(this)

            testPostChannelRegInjector?.let { throw it.invoke() }

            val callbackHandle = taskData.callbackHandle
            if (callbackHandle != null) {
                testCallbackLookupFailureInjector?.let { throw it.invoke() }

                val flutterLoader = FlutterInjector.instance().flutterLoader()
                val bundlePath = flutterLoader.findAppBundlePath()
                val callbackInfo = FlutterCallbackInformation.lookupCallbackInformation(callbackHandle)
                    ?: throw IllegalStateException("Callback information not found for handle: $callbackHandle")

                testDartEntrypointFailureInjector?.let { throw it.invoke() }

                val dartCallback = DartExecutor.DartCallback(context.assets, bundlePath, callbackInfo)

                testExecuteDartFailureInjector?.let { throw it.invoke() }

                flutterEngine.dartExecutor.executeDartCallback(dartCallback)
            }
        } catch (t: Throwable) {
            destroy(false)
            if (t is Exception) throw t
            else throw RuntimeException(t)
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> start()
            else -> result.notImplemented()
        }
    }

    private fun start() {
        runIfNotDestroyed {
            runIfCallbackHandleExists {
                val serviceAction = serviceStatus.action
                val starter = if (serviceAction == ForegroundServiceAction.API_START ||
                    serviceAction == ForegroundServiceAction.API_RESTART ||
                    serviceAction == ForegroundServiceAction.API_UPDATE) {
                    FlutterForegroundTaskStarter.DEVELOPER
                } else {
                    FlutterForegroundTaskStarter.SYSTEM
                }

                backgroundChannel?.invokeMethod(ACTION_TASK_START, starter.ordinal) {
                    runIfNotDestroyed {
                        startRepeatTask()
                    }
                }
                taskLifecycleListener.onTaskStart(starter)
            }
        }
    }

    private fun invokeTaskRepeatEvent() {
        backgroundChannel?.invokeMethod(ACTION_TASK_REPEAT_EVENT, null)
        taskLifecycleListener.onTaskRepeatEvent()
    }

    private fun startRepeatTask() {
        stopRepeatTask()

        val type = taskEventAction.type
        val interval = taskEventAction.interval

        if (type == ForegroundTaskEventType.NOTHING) {
            return
        }

        if (type == ForegroundTaskEventType.ONCE) {
            invokeTaskRepeatEvent()
            return
        }

        repeatTask = CoroutineScope(Dispatchers.Default).launch {
            while (true) {
                delay(interval)
                withContext(Dispatchers.Main) {
                    try {
                        invokeTaskRepeatEvent()
                    } catch (e: Exception) {
                        Log.e("DutyForegroundTask", "repeatTask", e)
                    }
                }
            }
        }
    }

    private fun stopRepeatTask() {
        repeatTask?.cancel()
        repeatTask = null
    }

    fun invokeMethod(method: String, data: Any?) {
        runIfNotDestroyed {
            backgroundChannel?.invokeMethod(method, data)
        }
    }

    fun update(taskEventAction: ForegroundTaskEventAction) {
        runIfNotDestroyed {
            runIfCallbackHandleExists {
                this.taskEventAction = taskEventAction
                startRepeatTask()
            }
        }
    }

    fun destroy(isTimeout: Boolean) {
        runIfNotDestroyed {
            stopRepeatTask()

            val channel = backgroundChannel
            channel?.setMethodCallHandler(null)
            backgroundChannel = null

            if (taskData.callbackHandle == null) {
                taskLifecycleListener.onEngineWillDestroy()
                flutterEngine.destroy()
            } else {
                channel?.invokeMethod(ACTION_TASK_DESTROY, isTimeout) {
                    flutterEngine.destroy()
                } ?: run {
                    flutterEngine.destroy()
                }
                taskLifecycleListener.onTaskDestroy()
                taskLifecycleListener.onEngineWillDestroy()
            }

            isDestroyed = true
        }
    }

    private fun runIfCallbackHandleExists(call: () -> Unit) {
        if (taskData.callbackHandle == null) return
        call()
    }

    private fun runIfNotDestroyed(call: () -> Unit) {
        if (isDestroyed) return
        call()
    }

    private fun MethodChannel.invokeMethod(method: String, data: Any?, onComplete: () -> Unit = {}) {
        val callback = object : MethodChannel.Result {
            override fun success(result: Any?) { onComplete() }
            override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) { onComplete() }
            override fun notImplemented() { onComplete() }
        }
        invokeMethod(method, data, callback)
    }
}

/**
 * Concrete lifecycle binding tying a session's token to its specific task and engine instance.
 */
class ServiceTaskBinding(
    val token: SessionToken,
    var task: DutyForegroundTask? = null,
    var flutterEngine: FlutterEngine? = null
) {
    private val lock = Any()
    @Volatile
    var isDestroyed: Boolean = false
        private set

    @Volatile
    var destructionError: String? = null
        private set

    @Volatile
    var isTeardownPending: Boolean = false
        private set

    private val completionCallbacks = mutableListOf<(Boolean, String?) -> Unit>()

    fun onLifecycleDestroyed(success: Boolean, error: String? = null) {
        synchronized(lock) {
            if (isDestroyed) return
            isDestroyed = true
            isTeardownPending = false
            destructionError = error
        }
    }

    fun awaitCompletion(callback: (Boolean, String?) -> Unit) {
        var immediateCall: ((Boolean, String?) -> Unit)? = null
        synchronized(lock) {
            if (isDestroyed && !isTeardownPending) {
                immediateCall = callback
            } else {
                completionCallbacks.add(callback)
            }
        }
        immediateCall?.invoke(destructionError == null, destructionError)
    }

    fun awaitDestruction(callback: (Boolean, String?) -> Unit) {
        awaitCompletion(callback)
    }

    fun notifyCompletion(success: Boolean, error: String? = null) {
        val toNotify: List<(Boolean, String?) -> Unit>
        synchronized(lock) {
            isTeardownPending = false
            destructionError = error
            toNotify = completionCallbacks.toList()
            completionCallbacks.clear()
        }
        for (cb in toNotify) {
            try { cb(success, error) } catch (_: Exception) {}
        }
    }

    fun markTeardownPending() {
        synchronized(lock) {
            isTeardownPending = true
        }
    }

    fun markTeardownFailed(error: String?) {
        val toNotify: List<(Boolean, String?) -> Unit>
        synchronized(lock) {
            isTeardownPending = false
            destructionError = error
            toNotify = completionCallbacks.toList()
            completionCallbacks.clear()
        }
        for (cb in toNotify) {
            try { cb(false, error) } catch (_: Exception) {}
        }
    }
}

/**
 * Dedicated session-aware Android foreground service for active duty location updates.
 *
 * Enforces command-time and execution-time epoch boundary checks before starting
 * or stopping the foreground service. Rejects stale or unauthorized commands to
 * guarantee that:
 * 1. Cancelled/stopped pending starts never produce an ownerless running service.
 * 2. Old S1 starts never start or replace an authoritative S2 service.
 * 3. Old S1 stops never terminate a newer S2 service.
 * 4. Stop operations only report completion after effective teardown.
 */
class DutyForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.towmitra.driver.ACTION_START"
        const val ACTION_STOP = "com.towmitra.driver.ACTION_STOP"
        const val ACTION_UPDATE = "com.towmitra.driver.ACTION_UPDATE"
        const val ACTION_RESTART = "com.towmitra.driver.ACTION_RESTART"

        const val EXTRA_UID = "extra_uid"
        const val EXTRA_SESSION_ID = "extra_session_id"
        const val EXTRA_GENERATION = "extra_generation"
        const val EXTRA_LIFECYCLE_SEQ = "extra_lifecycle_seq"
        const val EXTRA_NOTIFICATION_TITLE = "extra_notification_title"
        const val EXTRA_NOTIFICATION_TEXT = "extra_notification_text"
        const val EXTRA_CALLBACK_HANDLE = "extra_callback_handle"
        const val EXTRA_ALLOW_WAKE_LOCK = "extra_allow_wake_lock"
        const val EXTRA_ALLOW_WIFI_LOCK = "extra_allow_wifi_lock"

        const val NOTIFICATION_CHANNEL_ID = "driver_duty_channel"
        const val NOTIFICATION_ID = 256

        @Volatile
        var activeWakeLock: PowerManager.WakeLock? = null

        @Volatile
        var activeWifiLock: WifiManager.WifiLock? = null

        @Volatile
        var lockOwnerToken: SessionToken? = null

        fun isWakeLockHeld(): Boolean = activeWakeLock?.isHeld == true
        fun isWifiLockHeld(): Boolean = activeWifiLock?.isHeld == true

        @JvmField
        @Volatile
        var testLoaderInitFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testEngineAllocatedBeforeDependencyInitInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPreEngineFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostEngineAllocationInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostPluginRegistrationInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostEngineChannelRegistrationInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testTaskConstructorFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostEngineFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testPostTaskFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testRestartReconstructionFailureInjector: (() -> Exception)? = null

        @JvmField
        @Volatile
        var testRestartBindingFactory: ((SessionToken) -> ServiceTaskBinding?)? = null

        @JvmStatic
        fun isHealthyRunning(): Boolean {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (!isRunning) return false
                if (activeState != NativeOwnershipCoordinator.STATE_ACTIVE) return false
                val binding = activeTaskBinding ?: return false
                if (binding.token != getActiveToken() || binding.isDestroyed || binding.isTeardownPending) return false
                if (bypassAndroidSystemServicesForTesting) return true
                if (instance == null) return false
                if (binding.task == null) return false
                if (binding.flutterEngine == null) return false
                return true
            }
        }

        @JvmStatic
        fun cleanQuarantineMalformedOwner(prefs: SharedPreferences, expectedOwnerJson: String) {
            if (prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null) != expectedOwnerJson) return
            try {
                prefs.edit()
                    .remove(NativeOwnershipCoordinator.KEY_OWNER_RECORD)
                    .remove(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD)
                    .remove(NativeOwnershipCoordinator.KEY_ACTIVE_TOKEN_EPOCH)
                    .remove(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE)
                    .remove(NativeOwnershipCoordinator.KEY_RESTART_READINESS_GRANT)
                    .putString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, NativeOwnershipCoordinator.LIFECYCLE_TERMINAL_REVOKED)
                    .putString(NativeOwnershipCoordinator.KEY_OWNER_STATE, NativeOwnershipCoordinator.STATE_STOPPED)
                    .commit()
            } catch (_: Throwable) {}
        }

        fun getActiveToken(): SessionToken? {
            val uid = activeUid
            val sid = activeSessionId
            val gen = activeGeneration
            val seq = activeLifecycleSeq
            return if (uid != null && sid != null && gen != null && seq != null) {
                SessionToken(uid, sid, gen, seq)
            } else null
        }

        fun acquireLocks(context: Context?, token: SessionToken, allowWakeLock: Boolean, allowWifiLock: Boolean) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (lockOwnerToken != null && lockOwnerToken != token) {
                    releaseLocks(lockOwnerToken)
                }
                val ctx = appContext ?: context?.applicationContext ?: context
                if (allowWakeLock && (activeWakeLock == null || !activeWakeLock!!.isHeld)) {
                    try {
                        val pm = ctx?.getSystemService(Context.POWER_SERVICE) as? PowerManager
                        pm?.let {
                            val wl = it.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DutyForegroundService::WakeLock")
                            wl.setReferenceCounted(false)
                            wl.acquire()
                            activeWakeLock = wl
                        }
                    } catch (_: Throwable) {}
                }
                if (allowWifiLock && (activeWifiLock == null || !activeWifiLock!!.isHeld)) {
                    try {
                        val wm = ctx?.applicationContext?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                            ?: ctx?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                        wm?.let {
                            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            } else {
                                @Suppress("DEPRECATION")
                                WifiManager.WIFI_MODE_FULL_HIGH_PERF
                            }
                            val wl = it.createWifiLock(mode, "DutyForegroundService::WifiLock")
                            wl.setReferenceCounted(false)
                            wl.acquire()
                            activeWifiLock = wl
                        }
                    } catch (_: Throwable) {}
                }
                lockOwnerToken = token
            }
        }

        fun releaseLocks(token: SessionToken?) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (token != null && lockOwnerToken != null && token != lockOwnerToken) {
                    return
                }
                try {
                    if (activeWakeLock?.isHeld == true) {
                        activeWakeLock?.release()
                    }
                } catch (_: Throwable) {}
                try {
                    if (activeWifiLock?.isHeld == true) {
                        activeWifiLock?.release()
                    }
                } catch (_: Throwable) {}
                activeWakeLock = null
                activeWifiLock = null
                lockOwnerToken = null
            }
        }

        fun handleWorkerBootstrapFailure(token: SessionToken): Map<String, Any?> {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                val binding = taskBindings.remove(token) ?: if (activeTaskBinding?.token == token) activeTaskBinding else null
                if (activeTaskBinding?.token == token) {
                    activeTaskBinding = null
                    instance?.foregroundTask = null
                }
                val taskToDestroy = binding?.task
                val engineToDestroy = binding?.flutterEngine
                engineToDestroy?.let { engine ->
                    try {
                        NativeOwnershipCoordinator.unregisterEngine(engine.dartExecutor.binaryMessenger)
                    } catch (_: Throwable) {}
                }
                runOnMainThreadIfNeeded {
                    try { taskToDestroy?.destroy(false) } catch (_: Throwable) {}
                    try { engineToDestroy?.destroy() } catch (_: Throwable) {}
                }
                binding?.flutterEngine = null
                binding?.task = null
                try {
                    binding?.onLifecycleDestroyed(true, "Worker bootstrap failed")
                } catch (_: Throwable) {}

                val isAuthoritative = (activeSessionId == token.sessionId && activeLifecycleSeq == token.lifecycleSeq && activeUid == token.uid) ||
                    activeStartAuthorization == token

                if (isAuthoritative) {
                    val prefs = instance?.getPrefs() ?: appContext?.getSharedPreferences(NativeOwnershipCoordinator.PREFS_NAME, Context.MODE_PRIVATE)
                    var rollbackSucceeded = true
                    if (prefs != null) {
                        rollbackSucceeded = NativeOwnershipCoordinator.safeRollbackStart(prefs, token.uid, token.sessionId, token.generation, token.lifecycleSeq)
                    }
                    activeStartAuthorization = null
                    isRunning = false
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED
                    releaseLocks(token)
                    instance?.let { inst ->
                        runOnMainThreadIfNeeded {
                            inst.abortForegroundStartAndStop(-1, foregroundAlreadyStarted = true, token = token)
                        }
                    }

                    return if (rollbackSucceeded) {
                        mapOf(
                            "success" to true,
                            "cleaned" to true,
                            "uid" to token.uid,
                            "sessionId" to token.sessionId,
                            "generation" to token.generation,
                            "lifecycleSeq" to token.lifecycleSeq
                        )
                    } else {
                        mapOf(
                            "success" to false,
                            "cleaned" to false,
                            "cleanupRequired" to true,
                            "reason" to "rollback_persistence_failed",
                            "uid" to token.uid,
                            "sessionId" to token.sessionId,
                            "generation" to token.generation,
                            "lifecycleSeq" to token.lifecycleSeq
                        )
                    }
                } else {
                    return mapOf(
                        "success" to true,
                        "cleaned" to true,
                        "reason" to "superseded",
                        "uid" to token.uid,
                        "sessionId" to token.sessionId,
                        "generation" to token.generation,
                        "lifecycleSeq" to token.lifecycleSeq
                    )
                }
            }
        }

        fun confirmWorkerReadiness(token: SessionToken): Map<String, Any?> {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                val prefs = instance?.getPrefs() ?: appContext?.getSharedPreferences(NativeOwnershipCoordinator.PREFS_NAME, Context.MODE_PRIVATE)
                if (prefs == null) {
                    return mapOf("success" to false, "reason" to "no_context")
                }
                val currentJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
                if (currentJson == null) {
                    return mapOf("success" to false, "reason" to "no_owner_record")
                }
                try {
                    val obj = JSONObject(currentJson)
                    val curUid = NativeOwnershipCoordinator.parseStrictString(obj.opt("uid"))
                    val curSessionId = NativeOwnershipCoordinator.parseStrictString(obj.opt("sessionId"))
                    val curGen = NativeOwnershipCoordinator.parseStrictInt(obj.opt("generation"))
                    val curSeq = NativeOwnershipCoordinator.parseStrictLong(obj.opt("lifecycleSeq"))
                    val curState = NativeOwnershipCoordinator.parseStrictString(obj.opt("state"))

                    if (curUid != token.uid || curSessionId != token.sessionId ||
                        curGen != token.generation || curSeq != token.lifecycleSeq) {
                        return mapOf("success" to false, "reason" to "epoch_mismatch")
                    }
                    if (curState != NativeOwnershipCoordinator.STATE_ACTIVE) {
                        return mapOf("success" to false, "reason" to "not_active")
                    }

                    val committed = NativeOwnershipCoordinator.setRestartReadinessGrant(prefs, token)
                    return if (committed) {
                        mapOf("success" to true, "granted" to true)
                    } else {
                        mapOf("success" to false, "granted" to false, "reason" to "commit_failed")
                    }
                } catch (e: Exception) {
                    return mapOf("success" to false, "reason" to "exception", "error" to (e.message ?: ""))
                }
            }
        }

        @JvmStatic
        fun runOnMainThreadIfNeeded(action: () -> Unit) {
            val mainLooper = try {
                Looper.getMainLooper()
            } catch (_: Throwable) {
                null
            }
            if (mainLooper != null) {
                val myLooper = try { Looper.myLooper() } catch (_: Throwable) { null }
                if (myLooper != mainLooper) {
                    val handler = Handler(mainLooper)
                    val latch = CountDownLatch(1)
                    var error: Throwable? = null
                    handler.post {
                        try {
                            action()
                        } catch (t: Throwable) {
                            error = t
                        } finally {
                            latch.countDown()
                        }
                    }
                    try {
                        latch.await(5, TimeUnit.SECONDS)
                    } catch (_: InterruptedException) {}
                    val err = error
                    if (err != null) {
                        if (err is Exception) throw err
                        else throw RuntimeException(err)
                    }
                    return
                }
            }
            action()
        }

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var activeUid: String? = null
            private set

        @Volatile
        var activeSessionId: String? = null
            private set

        @Volatile
        var activeGeneration: Int? = null
            private set

        @Volatile
        var activeLifecycleSeq: Long? = null
            private set

        @Volatile
        var activeState: String = NativeOwnershipCoordinator.STATE_STOPPED
            private set

        @Volatile
        var instance: DutyForegroundService? = null
            private set

        @Volatile
        var activeTaskBinding: ServiceTaskBinding? = null

        @Volatile
        var bypassAndroidSystemServicesForTesting: Boolean = false

        @Volatile
        var commandExecutionHook: ((action: String, intent: Intent?) -> Unit)? = null

        @Volatile
        var testCommitFailureInjector: ((operation: String) -> Boolean)? = null

        @Volatile
        var teardownInterceptor: ((token: SessionToken, proceed: (success: Boolean, error: String?) -> Unit) -> Unit)? = null

        @Volatile
        var appContext: Context? = null

        @Volatile
        var holdPendingStartsForTesting: Boolean = false

        @Volatile
        var activeStartAuthorization: SessionToken? = null

        @Volatile
        var lastStartReason: String? = null

        @Volatile
        var lastStartError: String? = null

        @Volatile
        var startTimeoutMs: Long = 5000L

        @JvmField
        @Volatile
        var testTaskCreationFailureInjector: (() -> Exception)? = null

        private val pendingStartListeners = ConcurrentHashMap<SessionToken, (Boolean, Boolean, String?, String?) -> Unit>()
        private val pendingStartFutures = ConcurrentHashMap<SessionToken, ScheduledFuture<*>>()
        val inFlightStartupFutures = ConcurrentHashMap<SessionToken, Future<*>>()
        val startIdsForToken = ConcurrentHashMap<SessionToken, Int>()

        @Volatile
        var provisionalForegroundToken: SessionToken? = null

        private val startTimeoutExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "DutyStartTimeout").apply { isDaemon = true }
        }
        private val startupWorkerExecutor: ExecutorService = Executors.newCachedThreadPool { r ->
            Thread(r, "DutyStartupWorker").apply { isDaemon = true }
        }

        @Volatile
        var inFlightStartupToken: SessionToken? = null

        @Volatile
        var syncStartupForTesting: Boolean = false

        @Volatile
        var activeStartupFuture: Future<*>? = null

        @JvmStatic
        fun awaitStartupCompletionForTesting(timeoutMs: Long = 10000L): Boolean {
            val f = activeStartupFuture ?: return true
            return try {
                f.get(timeoutMs, TimeUnit.MILLISECONDS)
                true
            } catch (_: Throwable) {
                false
            }
        }

        @JvmStatic
        fun currentElapsedRealtime(): Long {
            return try {
                SystemClock.elapsedRealtime()
            } catch (_: Throwable) {
                System.nanoTime() / 1_000_000L
            }
        }

        @JvmStatic
        fun grantStartAuthorization(token: SessionToken) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                activeStartAuthorization = token
            }
        }

        @JvmStatic
        fun revokeStartAuthorization(token: SessionToken? = null) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (token == null || activeStartAuthorization == token) {
                    activeStartAuthorization = null
                }
            }
        }

        @JvmStatic
        fun triggerStartTimeoutForTesting(token: SessionToken) {
            handleStartTimeout(token)
        }

        @JvmStatic
        fun handleStartTimeout(token: SessionToken) {
            val listener: ((Boolean, Boolean, String?, String?) -> Unit)?
            var shouldTeardownProvisional = false
            var tokenStartId = -1
            val currentInstance: DutyForegroundService?

            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                pendingStartFutures.remove(token)?.cancel(false)
                listener = pendingStartListeners.remove(token)
                tokenStartId = startIdsForToken.remove(token) ?: -1
                currentInstance = instance

                if (activeStartAuthorization == token) {
                    activeStartAuthorization = null
                }

                if (!isRunning && (provisionalForegroundToken == token || inFlightStartupToken == token)) {
                    val auth = activeStartAuthorization
                    val hasNewerAuth = auth != null && auth.lifecycleSeq > token.lifecycleSeq
                    val hasNewerActive = activeLifecycleSeq != null && activeLifecycleSeq!! > token.lifecycleSeq
                    if (!hasNewerAuth && !hasNewerActive) {
                        shouldTeardownProvisional = true
                        if (provisionalForegroundToken == token) {
                            provisionalForegroundToken = null
                        }
                    }
                }

                val ctx = appContext ?: instance?.applicationContext ?: NativeOwnershipCoordinator.getAppContext()
                if (ctx != null) {
                    val prefs = ctx.getSharedPreferences(NativeOwnershipCoordinator.PREFS_NAME, Context.MODE_PRIVATE)
                    NativeOwnershipCoordinator.safeRollbackStart(prefs, token.uid, token.sessionId, token.generation, token.lifecycleSeq)
                }
            }

            listener?.invoke(false, false, "timeout", "Start timed out waiting for native service activation")

            if (shouldTeardownProvisional && currentInstance != null) {
                runOnMainThreadIfNeeded {
                    currentInstance.abortForegroundStartAndStop(
                        startId = tokenStartId,
                        foregroundAlreadyStarted = true,
                        token = token
                    )
                }
            }
        }

        fun notifyStartCompletion(
            token: SessionToken,
            success: Boolean,
            active: Boolean,
            reason: String?,
            error: String?
        ) {
            val listener: ((Boolean, Boolean, String?, String?) -> Unit)?
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                pendingStartFutures.remove(token)?.cancel(false)
                listener = pendingStartListeners.remove(token)
            }
            listener?.invoke(success, active, reason, error)
        }

        val pendingStartIntentsForTesting = mutableListOf<Intent>()

        fun executePendingStartsForTesting() {
            val intents = synchronized(pendingStartIntentsForTesting) {
                val copy = pendingStartIntentsForTesting.toList()
                pendingStartIntentsForTesting.clear()
                copy
            }
            for (intent in intents) {
                instance?.onStartCommand(intent, 0, 1)
            }
            if (syncStartupForTesting) {
                awaitStartupCompletionForTesting()
            }
        }

        val taskBindings = ConcurrentHashMap<SessionToken, ServiceTaskBinding>()

        fun hasBindingForToken(token: SessionToken): Boolean {
            val b = taskBindings[token]
            return b != null && !b.isDestroyed
        }

        fun isFlutterEngineAttached(engine: FlutterEngine?): Boolean {
            if (engine == null) return false
            return try {
                val jniField = FlutterEngine::class.java.getDeclaredField("flutterJNI")
                jniField.isAccessible = true
                val jni = jniField.get(engine) ?: return false
                val isAttachedMethod = jni.javaClass.getMethod("isAttached")
                isAttachedMethod.isAccessible = true
                (isAttachedMethod.invoke(jni) as? Boolean) ?: false
            } catch (_: NoSuchFieldException) {
                try {
                    val destroyedField = engine.javaClass.getDeclaredField("destroyed")
                    destroyedField.isAccessible = true
                    val isDestroyed = (destroyedField.get(engine) as? Boolean) ?: true
                    !isDestroyed
                } catch (_: Throwable) {
                    false
                }
            } catch (_: Throwable) {
                false
            }
        }

        fun resetForTesting(context: Context? = null, serviceInstance: DutyForegroundService? = null) {
            isRunning = false
            activeUid = null
            activeSessionId = null
            activeGeneration = null
            activeLifecycleSeq = null
            activeState = NativeOwnershipCoordinator.STATE_STOPPED
            activeTaskBinding = null
            taskBindings.clear()
            activeWakeLock?.let { try { if (it.isHeld) it.release() } catch (_: Throwable) {} }
            activeWifiLock?.let { try { if (it.isHeld) it.release() } catch (_: Throwable) {} }
            activeWakeLock = null
            activeWifiLock = null
            lockOwnerToken = null
            instance = serviceInstance
            bypassAndroidSystemServicesForTesting = true
            commandExecutionHook = null
            testCommitFailureInjector = null
            testTaskCreationFailureInjector = null
            testLoaderInitFailureInjector = null
            DutyForegroundTask.resetTestInjectors()
            testEngineAllocatedBeforeDependencyInitInjector = null
            testPreEngineFailureInjector = null
            testPostEngineAllocationInjector = null
            testPostPluginRegistrationInjector = null
            testPostEngineChannelRegistrationInjector = null
            testTaskConstructorFailureInjector = null
            testPostEngineFailureInjector = null
            testPostTaskFailureInjector = null
            testRestartReconstructionFailureInjector = null
            testRestartBindingFactory = null
            teardownInterceptor = null
            appContext = context
            holdPendingStartsForTesting = false
            activeStartAuthorization = null
            lastStartReason = null
            lastStartError = null
            startTimeoutMs = 5000L
            activeStartupFuture?.cancel(true)
            activeStartupFuture = null
            for (f in inFlightStartupFutures.values) {
                f.cancel(true)
            }
            inFlightStartupFutures.clear()
            startIdsForToken.clear()
            provisionalForegroundToken = null
            inFlightStartupToken = null
            syncStartupForTesting = true
            for (f in pendingStartFutures.values) {
                f.cancel(false)
            }
            pendingStartFutures.clear()
            val pending = pendingStartListeners.values.toList()
            pendingStartListeners.clear()
            for (cb in pending) {
                try { cb(false, false, "reset", null) } catch (_: Throwable) {}
            }
            synchronized(pendingStartIntentsForTesting) {
                pendingStartIntentsForTesting.clear()
            }
        }

        /**
         * Dispatches a START command intent carrying the complete immutable epoch token.
         */
        fun startServiceWithToken(
            context: Context,
            uid: String,
            sessionId: String,
            generation: Int,
            lifecycleSeq: Long,
            notificationTitle: String?,
            notificationText: String?,
            callbackHandle: Long,
            onComplete: ((success: Boolean, active: Boolean, reason: String?, error: String?) -> Unit)? = null
        ) {
            val token = SessionToken(uid, sessionId, generation, lifecycleSeq)

            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                // If this exact token is already running and active, complete immediately
                if (isRunning && activeSessionId == sessionId && activeLifecycleSeq == lifecycleSeq) {
                    onComplete?.invoke(true, true, null, null)
                    return
                }

                // Replacement: Cancel and complete any pending start listener for older or different tokens
                val existingTokens = pendingStartListeners.keys.toList()
                for (oldToken in existingTokens) {
                    if (oldToken != token) {
                        pendingStartFutures.remove(oldToken)?.cancel(false)
                        val oldListener = pendingStartListeners.remove(oldToken)
                        oldListener?.invoke(false, false, "superseded", "Startup superseded by newer epoch")
                        if (activeStartAuthorization == oldToken) {
                            activeStartAuthorization = null
                        }
                    }
                }

                grantStartAuthorization(token)

                if (onComplete != null) {
                    val existingListener = pendingStartListeners[token]
                    if (existingListener != null) {
                        pendingStartListeners[token] = { success, active, reason, error ->
                            try { existingListener(success, active, reason, error) } catch (_: Throwable) {}
                            try { onComplete(success, active, reason, error) } catch (_: Throwable) {}
                        }
                    } else {
                        pendingStartListeners[token] = onComplete
                        if (startTimeoutMs > 0) {
                            try {
                                val future = startTimeoutExecutor.schedule({
                                    handleStartTimeout(token)
                                }, startTimeoutMs, TimeUnit.MILLISECONDS)
                                pendingStartFutures[token] = future
                            } catch (_: Throwable) {}
                        }
                    }
                }
            }

            val intent = DutyIntent(context, DutyForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_UID, uid)
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_GENERATION, generation)
                putExtra(EXTRA_LIFECYCLE_SEQ, lifecycleSeq)
                putExtra(EXTRA_NOTIFICATION_TITLE, notificationTitle)
                putExtra(EXTRA_NOTIFICATION_TEXT, notificationText)
                putExtra(EXTRA_CALLBACK_HANDLE, callbackHandle)
                putExtra(EXTRA_ALLOW_WAKE_LOCK, true)
                putExtra(EXTRA_ALLOW_WIFI_LOCK, true)
            }

            if (!bypassAndroidSystemServicesForTesting) {
                ContextCompat.startForegroundService(context, intent)
            } else {
                if (holdPendingStartsForTesting) {
                    synchronized(pendingStartIntentsForTesting) {
                        pendingStartIntentsForTesting.add(intent)
                    }
                } else {
                    instance?.onStartCommand(intent, 0, 1)
                }
            }
        }

        /**
         * Effectively terminates the foreground service if the active session matches the caller's token.
         * Executes teardown truthfully and asynchronously.
         */
        fun stopServiceWithToken(
            context: Context,
            expectedUid: String?,
            expectedSessionId: String?,
            expectedGeneration: Int?,
            expectedLifecycleSeq: Long?,
            onComplete: (success: Boolean, stopped: Boolean, reason: String?, error: String?) -> Unit
        ) {
            val uid = NativeOwnershipCoordinator.parseStrictString(expectedUid)
            val sessionId = NativeOwnershipCoordinator.parseStrictString(expectedSessionId)
            val gen = NativeOwnershipCoordinator.parseStrictInt(expectedGeneration)
            val seq = NativeOwnershipCoordinator.parseStrictLong(expectedLifecycleSeq)

            if (uid == null || sessionId == null || gen == null || seq == null) {
                onComplete(false, false, "invalid_argument", "Invalid destructive token fields")
                return
            }

            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (!isRunning) {
                    onComplete(true, false, "service_not_running", null)
                    return
                }

                // Destructive boundary check against the currently running session
                if (activeUid != uid ||
                    activeSessionId != sessionId ||
                    activeLifecycleSeq != seq ||
                    activeGeneration != gen) {
                    // Stale or mismatched stop attempt: reject immediately, preserve active session!
                    onComplete(false, false, "ownership_mismatch", null)
                    return
                }

                val currentInstance = instance
                val token = SessionToken(uid, sessionId, gen, seq)

                if (currentInstance != null) {
                    currentInstance.executeEffectiveTeardown(token) { success, error ->
                        synchronized(NativeOwnershipCoordinator.ownershipLock) {
                            if (!success) {
                                onComplete(false, false, "teardown_failed", error)
                                return@synchronized
                            }

                            // Check if an ownership transfer occurred in the interim (e.g. S2 arrived while S1 teardown was delayed)
                            if (activeSessionId != sessionId || activeLifecycleSeq != seq) {
                                // Newer session is already active: do NOT clear active state! S2 remains running and authoritative!
                                onComplete(true, true, null, null)
                                return@synchronized
                            }

                            if (!bypassAndroidSystemServicesForTesting) {
                                try {
                                    currentInstance.stopSelf()
                                } catch (_: Exception) {}
                            }

                            isRunning = false
                            activeUid = null
                            activeSessionId = null
                            activeGeneration = null
                            activeLifecycleSeq = null
                            activeState = NativeOwnershipCoordinator.STATE_STOPPED

                            onComplete(true, true, null, null)
                        }
                    }
                } else {
                    isRunning = false
                    activeUid = null
                    activeSessionId = null
                    activeGeneration = null
                    activeLifecycleSeq = null
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED
                    onComplete(true, true, null, null)
                }
            }
        }
    }

    fun hasBindingForToken(token: SessionToken): Boolean = Companion.hasBindingForToken(token)

    private var foregroundTask: DutyForegroundTask? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            return handleSystemRestart(startId)
        }

        val action = intent.action ?: return START_NOT_STICKY
        if (action != ACTION_START) {
            commandExecutionHook?.invoke(action, intent)
        }

        val rawUid = getRawExtra(intent, EXTRA_UID)
        val rawSessionId = getRawExtra(intent, EXTRA_SESSION_ID)
        val rawGen = getRawExtra(intent, EXTRA_GENERATION)
        val rawSeq = getRawExtra(intent, EXTRA_LIFECYCLE_SEQ)

        val cmdUid = NativeOwnershipCoordinator.parseStrictString(rawUid)
        val cmdSessionId = NativeOwnershipCoordinator.parseStrictString(rawSessionId)
        val cmdGen = NativeOwnershipCoordinator.parseStrictInt(rawGen)
        val cmdSeq = NativeOwnershipCoordinator.parseStrictLong(rawSeq)

        when (action) {
            ACTION_START -> {
                handleStartCommand(intent, cmdUid, cmdSessionId, cmdGen, cmdSeq, startId)
                return START_STICKY
            }
            ACTION_STOP -> {
                handleStopCommand(intent, cmdUid, cmdSessionId, cmdGen, cmdSeq, startId)
                return START_NOT_STICKY
            }
            ACTION_UPDATE -> {
                handleUpdateCommand(intent, cmdUid ?: "", cmdSessionId ?: "", cmdGen ?: -1, cmdSeq ?: -1L)
                return START_STICKY
            }
            ACTION_RESTART -> {
                return handleSystemRestart(startId)
            }
        }

        return START_NOT_STICKY
    }

    private fun getPrefs(): SharedPreferences {
        val ctx = appContext ?: applicationContext ?: this
        return ctx.getSharedPreferences(NativeOwnershipCoordinator.PREFS_NAME, Context.MODE_PRIVATE)
    }

    private fun buildFallbackNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val channel = NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "Duty Location Tracking",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Active driver duty location tracking service"
                    enableVibration(false)
                    setShowBadge(false)
                }
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                nm?.createNotificationChannel(channel)
            } catch (_: Throwable) {}
        }
        val icon = try {
            if (applicationInfo != null && applicationInfo.icon != 0) applicationInfo.icon else android.R.drawable.ic_dialog_info
        } catch (_: Throwable) {
            android.R.drawable.ic_dialog_info
        }
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("On Duty")
            .setContentText("Location sharing is active")
            .setSmallIcon(icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun safeCreateNotification(title: String?, text: String?): Notification? {
        return try {
            createNotification(title, text)
        } catch (_: Throwable) {
            try {
                buildFallbackNotification()
            } catch (_: Throwable) {
                null
            }
        }
    }


    private fun abortForegroundStartAndStop(
        startId: Int,
        foregroundAlreadyStarted: Boolean = false,
        token: SessionToken? = null
    ) {
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            if (isRunning) return
            val prefs = getPrefs()
            val curOwnerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
            val curOwnerObj = if (curOwnerJson != null) {
                try { JSONObject(curOwnerJson) } catch (_: Exception) { null }
            } else null
            if (token != null && curOwnerObj != null) {
                val curSeq = curOwnerObj.optLong("lifecycleSeq")
                if (curSeq > token.lifecycleSeq) {
                    return
                }
            }
            if (token != null && activeStartAuthorization != null && activeStartAuthorization!!.lifecycleSeq > token.lifecycleSeq) {
                return
            }
            if (token != null && activeLifecycleSeq != null && activeLifecycleSeq!! > token.lifecycleSeq) {
                return
            }

            if (token == null || provisionalForegroundToken == token) {
                provisionalForegroundToken = null
            }

            if (!bypassAndroidSystemServicesForTesting) {
                try {
                    if (!foregroundAlreadyStarted) {
                        val notification = safeCreateNotification(null, null)
                        if (notification != null) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                            } else {
                                startForeground(NOTIFICATION_ID, notification)
                            }
                        }
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                } catch (_: Throwable) {}
                if (startId > 0) {
                    stopSelf(startId)
                } else {
                    stopSelf()
                }
            } else {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                } catch (_: Throwable) {}
                if (startId > 0) {
                    stopSelf(startId)
                } else {
                    stopSelf()
                }
            }
        }
    }

    private fun handleStartCommand(
        intent: Intent,
        cmdUid: String?,
        cmdSessionId: String?,
        cmdGen: Int?,
        cmdSeq: Long?,
        startId: Int
    ) {
        val cmdToken = if (cmdUid != null && cmdSessionId != null && cmdGen != null && cmdSeq != null) {
            SessionToken(cmdUid, cmdSessionId, cmdGen, cmdSeq)
        } else null

        if (cmdToken != null) {
            startIdsForToken[cmdToken] = startId
        }

        // Validate command arguments
        if (cmdUid == null || cmdSessionId == null || cmdGen == null || cmdGen < 0 || cmdSeq == null || cmdSeq <= 0L || cmdToken == null) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (cmdToken != null) {
                    notifyStartCompletion(cmdToken, false, false, "invalid_arguments", "Command arguments invalid")
                }
            }
            abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
            return
        }

        var foregroundPromoted = false
        val title = intent.getStringExtra(EXTRA_NOTIFICATION_TITLE)
        val text = intent.getStringExtra(EXTRA_NOTIFICATION_TEXT)
        val rawCallback = intent.extras?.get(EXTRA_CALLBACK_HANDLE) ?: intent.getLongExtra(EXTRA_CALLBACK_HANDLE, 0L)
        val callbackHandle = NativeOwnershipCoordinator.parseStrictCallbackHandle(rawCallback)
        if (callbackHandle == null) {
            notifyStartCompletion(cmdToken, false, false, "invalid_callback_handle", "Invalid or missing callbackHandle in intent")
            abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
            return
        }
        val token = cmdToken
        val deadlineElapsedRealtime = currentElapsedRealtime() + startTimeoutMs

        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            if (inFlightStartupToken == cmdToken && inFlightStartupFutures[cmdToken]?.isDone == false) {
                return
            }

            val prefs = getPrefs()
            val ownerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
            if (ownerJson == null || ownerJson.trim().isEmpty()) {
                notifyStartCompletion(cmdToken, false, false, "no_canonical_owner", null)
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }

            val ownerObj = try {
                JSONObject(ownerJson)
            } catch (_: Exception) {
                notifyStartCompletion(cmdToken, false, false, "corrupt_owner_record", null)
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }

            val ownerUid = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("uid"))
            val ownerSessionId = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("sessionId"))
            val ownerGen = NativeOwnershipCoordinator.parseStrictInt(ownerObj.opt("generation"))
            val ownerSeq = NativeOwnershipCoordinator.parseStrictLong(ownerObj.opt("lifecycleSeq"))
            if (ownerUid == null || ownerSessionId == null || ownerGen == null || ownerSeq == null) {
                notifyStartCompletion(cmdToken, false, false, "invalid_owner_record", null)
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }
            val ownerStateFromPrefs = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_STATE, null)
            val ownerState = if (ownerStateFromPrefs == NativeOwnershipCoordinator.STATE_FAILED_CLEANUP) {
                ownerStateFromPrefs
            } else {
                ownerObj.optString("state", "")
            }

            if (ownerUid != cmdUid || ownerSessionId != cmdSessionId ||
                ownerGen != cmdGen || ownerSeq != cmdSeq) {
                notifyStartCompletion(cmdToken, false, false, "stale_command", "Command does not match current canonical owner")
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }

            if (ownerState != NativeOwnershipCoordinator.STATE_PENDING_START &&
                ownerState != NativeOwnershipCoordinator.STATE_ACTIVE) {
                notifyStartCompletion(cmdToken, false, false, "invalid_owner_state", "Owner state is not PENDING_START or ACTIVE")
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }

            val grant = activeStartAuthorization
            if (grant != cmdToken) {
                notifyStartCompletion(cmdToken, false, false, "unauthorized_or_revoked", "No active start authorization for this token")
                abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                return
            }

            if (!bypassAndroidSystemServicesForTesting) {
                val notification = safeCreateNotification(title, text)
                if (notification == null) {
                    notifyStartCompletion(cmdToken, false, false, "foreground_start_failed", "Failed to create foreground service notification")
                    abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                    return
                }
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                    foregroundPromoted = true
                    provisionalForegroundToken = cmdToken
                } catch (e: Exception) {
                    notifyStartCompletion(cmdToken, false, false, "foreground_start_failed", e.message)
                    abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                    return
                }
            } else {
                try {
                    val notification = safeCreateNotification(title, text)
                    if (notification != null) {
                        startForeground(NOTIFICATION_ID, notification)
                        foregroundPromoted = true
                        provisionalForegroundToken = cmdToken
                    }
                } catch (e: Exception) {
                    notifyStartCompletion(cmdToken, false, false, "foreground_start_failed", e.message)
                    abortForegroundStartAndStop(startId, foregroundAlreadyStarted = false, token = cmdToken)
                    return
                }
            }

            inFlightStartupToken = cmdToken
        }

        val startupFuture = startupWorkerExecutor.submit {
            performStartupWorkerAsync(
                intent = intent,
                token = token,
                callbackHandle = callbackHandle,
                deadlineElapsedRealtime = deadlineElapsedRealtime,
                startId = startId,
                foregroundPromoted = foregroundPromoted
            )
        }
        inFlightStartupFutures[token] = startupFuture
        activeStartupFuture = startupFuture

        if (syncStartupForTesting) {
            awaitStartupCompletionForTesting()
        }
    }

    private fun performTaskCreationOnMainThread(
        callbackHandle: Long,
        token: SessionToken,
        timeoutMs: Long
    ): Boolean {
        val mainLooper = try {
            Looper.getMainLooper()
        } catch (_: Throwable) {
            null
        }
        val myLooper = try { Looper.myLooper() } catch (_: Throwable) { null }

        if (mainLooper == null || myLooper == mainLooper) {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (activeStartAuthorization != token) {
                    return false
                }
                startBackgroundTask(callbackHandle, token)
                return true
            }
        }

        val handler = Handler(mainLooper)
        val latch = CountDownLatch(1)
        val creationSuccess = AtomicBoolean(false)
        val failureError = AtomicReference<Throwable?>(null)

        handler.post {
            var createdTask: DutyForegroundTask? = null
            var createdBinding: ServiceTaskBinding? = null
            var isExpired = false

            try {
                synchronized(NativeOwnershipCoordinator.ownershipLock) {
                    if (activeStartAuthorization != token) {
                        isExpired = true
                        return@post
                    }
                    startBackgroundTask(callbackHandle, token)
                    createdBinding = activeTaskBinding
                    createdTask = foregroundTask
                    creationSuccess.set(true)
                }
            } catch (t: Throwable) {
                failureError.set(t)
            } finally {
                latch.countDown()
            }

            if (!isExpired) {
                synchronized(NativeOwnershipCoordinator.ownershipLock) {
                    val isStillValid = (activeStartAuthorization == token) ||
                        (activeSessionId == token.sessionId && activeLifecycleSeq == token.lifecycleSeq)
                    if (!isStillValid) {
                        if (activeTaskBinding === createdBinding) {
                            activeTaskBinding = null
                        }
                        if (foregroundTask === createdTask) {
                            foregroundTask = null
                        }
                        taskBindings.remove(token)
                        try {
                            createdBinding?.onLifecycleDestroyed(false, "Expired during startup")
                            createdTask?.destroy(false)
                        } catch (_: Throwable) {}
                    }
                }
            }
        }

        val waitMs = timeoutMs.coerceAtLeast(50L)
        val completed = try {
            latch.await(waitMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            false
        }

        if (!completed) {
            return false
        }

        val err = failureError.get()
        if (err != null) {
            if (err is Exception) throw err
            else throw RuntimeException(err)
        }

        return creationSuccess.get()
    }

    private fun performStartupWorkerAsync(
        intent: Intent,
        token: SessionToken,
        callbackHandle: Long,
        deadlineElapsedRealtime: Long,
        startId: Int,
        foregroundPromoted: Boolean
    ) {
        var taskCreationAttempted = false
        var workerTaskCreated = false

        try {
            commandExecutionHook?.invoke(intent.action ?: "NULL_ACTION", intent)

            if (currentElapsedRealtime() >= deadlineElapsedRealtime) {
                throw IllegalStateException("Startup authorization timed out during startup")
            }

            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (activeStartAuthorization != token) {
                    throw IllegalStateException("Startup authorization revoked or timed out during startup")
                }
            }

            var existingTaskToDestroy: DutyForegroundTask? = null
            var existingBindingToDestroy: ServiceTaskBinding? = null
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                val existingBinding = activeTaskBinding
                if (existingBinding != null && existingBinding.token.lifecycleSeq < token.lifecycleSeq) {
                    activeTaskBinding = null
                    val existingTask = foregroundTask
                    foregroundTask = null
                    if (!existingBinding.isTeardownPending) {
                        existingTaskToDestroy = existingTask
                        existingBindingToDestroy = existingBinding
                    }
                }
            }
            if (existingTaskToDestroy != null) {
                runOnMainThreadIfNeeded {
                    try {
                        existingTaskToDestroy?.destroy(false)
                    } catch (_: Exception) {}
                }
            }
            try {
                existingBindingToDestroy?.onLifecycleDestroyed(true, null)
            } catch (_: Exception) {}

            if (!bypassAndroidSystemServicesForTesting) {
                if (callbackHandle != 0L) {
                    taskCreationAttempted = true
                    val remainingMs = deadlineElapsedRealtime - currentElapsedRealtime()
                    if (remainingMs <= 0L) {
                        throw IllegalStateException("Startup authorization timed out before task creation")
                    }
                    val created = performTaskCreationOnMainThread(callbackHandle, token, remainingMs)
                    if (!created) {
                        throw IllegalStateException("Worker task creation timed out or unauthorized")
                    }
                    workerTaskCreated = true
                }
            } else {
                taskCreationAttempted = true
                testTaskCreationFailureInjector?.let { injector ->
                    throw injector.invoke()
                }
                val binding = ServiceTaskBinding(token)
                taskBindings[token] = binding
                activeTaskBinding = binding
                workerTaskCreated = true
            }

            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (currentElapsedRealtime() >= deadlineElapsedRealtime) {
                    throw IllegalStateException("Startup authorization timed out during startup")
                }

                if (activeStartAuthorization != token) {
                    throw IllegalStateException("Startup authorization revoked or timed out during startup")
                }

                val prefs = getPrefs()
                val curOwnerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
                val curOwnerObj = if (curOwnerJson != null) {
                    try { JSONObject(curOwnerJson) } catch (_: Exception) { null }
                } else null
                val curOwnerState = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_STATE, curOwnerObj?.optString("state", ""))

                if (curOwnerObj == null ||
                    curOwnerObj.optString("sessionId") != token.sessionId ||
                    curOwnerObj.optLong("lifecycleSeq") != token.lifecycleSeq ||
                    curOwnerState != NativeOwnershipCoordinator.STATE_PENDING_START) {
                    throw IllegalStateException("Startup authorization revoked or superseded before commit")
                }

                if (taskCreationAttempted && !workerTaskCreated) {
                    throw IllegalStateException("Worker task creation incomplete")
                }

                curOwnerObj.put("state", NativeOwnershipCoordinator.STATE_ACTIVE)
                var activeCommitted = false
                var activeException: Exception? = null

                try {
                    val activeEditor = prefs.edit()
                        .putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, curOwnerObj.toString())
                        .putString(NativeOwnershipCoordinator.KEY_OWNER_STATE, NativeOwnershipCoordinator.STATE_ACTIVE)

                    if (testCommitFailureInjector?.invoke("active_commit") == true) {
                        try { activeEditor.commit() } catch (_: Exception) {}
                        activeCommitted = false
                    } else {
                        activeCommitted = activeEditor.commit()
                    }
                } catch (e: Exception) {
                    activeCommitted = false
                    activeException = e
                }

                if (!activeCommitted || activeException != null) {
                    throw IllegalStateException(activeException?.message ?: "Failed to commit active owner record")
                }

                activeStartAuthorization = null
                activeUid = token.uid
                activeSessionId = token.sessionId
                activeGeneration = token.generation
                activeLifecycleSeq = token.lifecycleSeq
                activeState = NativeOwnershipCoordinator.STATE_ACTIVE
                isRunning = true
                val allowWakeLock = (getRawExtra(intent, EXTRA_ALLOW_WAKE_LOCK) as? Boolean) ?: intent.getBooleanExtra(EXTRA_ALLOW_WAKE_LOCK, true)
                val allowWifiLock = (getRawExtra(intent, EXTRA_ALLOW_WIFI_LOCK) as? Boolean) ?: intent.getBooleanExtra(EXTRA_ALLOW_WIFI_LOCK, true)
                acquireLocks(this@DutyForegroundService, token, allowWakeLock, allowWifiLock)
                if (provisionalForegroundToken == token) {
                    provisionalForegroundToken = null
                }
                startIdsForToken.remove(token)

                notifyStartCompletion(token, true, true, null, null)
            }
        } catch (e: Exception) {
            handleStartupFailure(token, startId, foregroundPromoted, taskCreationAttempted, e)
        } finally {
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                inFlightStartupFutures.remove(token)
                if (inFlightStartupToken == token) {
                    inFlightStartupToken = null
                }
            }
        }
    }

    private fun handleStartupFailure(
        token: SessionToken,
        startId: Int,
        foregroundPromoted: Boolean,
        taskCreationAttempted: Boolean,
        e: Exception
    ) {
        val prefs = getPrefs()
        var bindingToDestroy: ServiceTaskBinding? = null
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            try {
                NativeOwnershipCoordinator.safeRollbackStart(prefs, token.uid, token.sessionId, token.generation, token.lifecycleSeq)
            } catch (_: Exception) {}

            try {
                val tokenBinding = taskBindings.remove(token)
                if (tokenBinding != null) {
                    bindingToDestroy = tokenBinding
                } else if (activeTaskBinding?.token == token) {
                    bindingToDestroy = activeTaskBinding
                }
                bindingToDestroy?.onLifecycleDestroyed(true, null)
            } catch (_: Exception) {}

            releaseLocks(token)

            if (activeStartAuthorization == token) {
                activeStartAuthorization = null
            }
            if ((activeSessionId == token.sessionId && activeLifecycleSeq == token.lifecycleSeq) ||
                activeTaskBinding?.token == token) {
                activeTaskBinding = null
                foregroundTask = null
                isRunning = false
                activeState = NativeOwnershipCoordinator.STATE_STOPPED
            }
            if (provisionalForegroundToken == token) {
                provisionalForegroundToken = null
            }
            startIdsForToken.remove(token)

            val reason = if (e.message?.contains("Failed to commit active owner record") == true || e.message?.contains("injected_active_commit_exception") == true) {
                "active_commit_failed"
            } else if (e.message?.contains("timed out") == true || e.message?.contains("revoked or superseded") == true) {
                "timeout"
            } else if (taskCreationAttempted && (testTaskCreationFailureInjector != null || e !is SecurityException)) {
                "task_creation_failed"
            } else {
                "foreground_start_failed"
            }
            lastStartReason = reason
            lastStartError = e.message
            notifyStartCompletion(token, false, false, reason, e.message)
        }

        val taskToDestroy = bindingToDestroy?.task
        val engineToDestroy = bindingToDestroy?.flutterEngine
        runOnMainThreadIfNeeded {
            try {
                taskToDestroy?.destroy(false)
            } catch (_: Exception) {}
            try {
                engineToDestroy?.destroy()
            } catch (_: Exception) {}
        }
        bindingToDestroy?.flutterEngine = null
        bindingToDestroy?.task = null

        runOnMainThreadIfNeeded {
            abortForegroundStartAndStop(startId, foregroundAlreadyStarted = foregroundPromoted, token = token)
        }
    }

    private fun handleStopCommand(
        intent: Intent,
        cmdUid: String?,
        cmdSessionId: String?,
        cmdGen: Int?,
        cmdSeq: Long?,
        startId: Int
    ) {
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            // Strict destructive token validation: reject missing, null, negative, or malformed fields
            if (cmdUid == null || cmdSessionId == null ||
                cmdGen == null || cmdGen < 0 ||
                cmdSeq == null || cmdSeq <= 0L) {
                return
            }

            if (!isRunning) {
                if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                return
            }

            // Verify against canonical owner in persistent storage
            val prefs = getPrefs()
            val ownerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
            if (ownerJson != null && ownerJson.isNotBlank()) {
                try {
                    val ownerObj = JSONObject(ownerJson)
                    val ownerUid = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("uid"))
                    val ownerSessionId = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("sessionId"))
                    val ownerGen = NativeOwnershipCoordinator.parseStrictInt(ownerObj.opt("generation"))
                    val ownerSeq = NativeOwnershipCoordinator.parseStrictLong(ownerObj.opt("lifecycleSeq"))
                    val ownerState = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("state"))

                    if (ownerUid == null || ownerSessionId == null || ownerGen == null || ownerSeq == null) {
                        return
                    }

                    if (ownerState == NativeOwnershipCoordinator.STATE_ACTIVE) {
                        if (cmdUid != ownerUid || cmdSessionId != ownerSessionId ||
                            cmdGen != ownerGen || cmdSeq != ownerSeq) {
                            // Contradicts canonical active owner! Reject to preserve active service.
                            return
                        }
                    }
                } catch (_: Exception) {
                    return
                }
            }

            // Verify against active session
            if (cmdUid != activeUid || cmdSessionId != activeSessionId ||
                cmdGen != activeGeneration || cmdSeq != activeLifecycleSeq) {
                // Stale or mismatched STOP: discard immediately!
                return
            }

            val token = SessionToken(cmdUid, cmdSessionId, cmdGen, cmdSeq)
            executeEffectiveTeardown(token) { success, error ->
                synchronized(NativeOwnershipCoordinator.ownershipLock) {
                    if (!success) {
                        val freshOwnerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
                        if (freshOwnerJson != null && freshOwnerJson.isNotBlank()) {
                            try {
                                val ownerObj = JSONObject(freshOwnerJson)
                                val freshUid = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("uid"))
                                val freshSessionId = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("sessionId"))
                                val freshGen = NativeOwnershipCoordinator.parseStrictInt(ownerObj.opt("generation"))
                                val freshSeq = NativeOwnershipCoordinator.parseStrictLong(ownerObj.opt("lifecycleSeq"))
                                if (freshSessionId == token.sessionId &&
                                    freshSeq == token.lifecycleSeq &&
                                    freshGen == token.generation &&
                                    freshUid == token.uid) {
                                    ownerObj.put("state", NativeOwnershipCoordinator.STATE_FAILED_CLEANUP)
                                    prefs.edit()
                                        .putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, ownerObj.toString())
                                        .putString(NativeOwnershipCoordinator.KEY_OWNER_STATE, NativeOwnershipCoordinator.STATE_FAILED_CLEANUP)
                                        .commit()
                                }
                            } catch (_: Exception) {}
                        }
                        return@synchronized
                    }

                    // If active session has changed in the interim (e.g. S2 arrived), do not stop S2!
                    if (activeSessionId != cmdSessionId || activeLifecycleSeq != cmdSeq ||
                        activeGeneration != cmdGen || activeUid != cmdUid) {
                        return@synchronized
                    }

                    isRunning = false
                    activeUid = null
                    activeSessionId = null
                    activeGeneration = null
                    activeLifecycleSeq = null
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED

                    if (!bypassAndroidSystemServicesForTesting) {
                        stopSelf(startId)
                    }
                }
            }
        }
    }

    private fun handleUpdateCommand(
        intent: Intent,
        cmdUid: String,
        cmdSessionId: String,
        cmdGen: Int,
        cmdSeq: Long
    ) {
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            if (!isRunning || activeSessionId != cmdSessionId ||
                activeLifecycleSeq != cmdSeq || (cmdGen >= 0 && activeGeneration != cmdGen)) {
                return
            }

            if (!bypassAndroidSystemServicesForTesting) {
                val title = intent.getStringExtra(EXTRA_NOTIFICATION_TITLE)
                val text = intent.getStringExtra(EXTRA_NOTIFICATION_TEXT)
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                nm?.notify(NOTIFICATION_ID, createNotification(title, text))
            }
        }
    }

    private fun failClosedRestart(prefs: SharedPreferences, token: SessionToken, startId: Int) {
        releaseLocks(token)
        val binding = taskBindings.remove(token) ?: if (activeTaskBinding?.token == token) activeTaskBinding else null
        if (activeTaskBinding?.token == token) {
            activeTaskBinding = null
            foregroundTask = null
        }
        val taskToDestroy = binding?.task
        val engineToDestroy = binding?.flutterEngine
        engineToDestroy?.let { engine ->
            try {
                NativeOwnershipCoordinator.unregisterEngine(engine.dartExecutor.binaryMessenger)
            } catch (_: Throwable) {}
        }
        runOnMainThreadIfNeeded {
            try { taskToDestroy?.destroy(false) } catch (_: Throwable) {}
            try { engineToDestroy?.destroy() } catch (_: Throwable) {}
        }
        binding?.flutterEngine = null
        binding?.task = null
        try { binding?.onLifecycleDestroyed(false, "Restart reconstruction failed") } catch (_: Throwable) {}

        NativeOwnershipCoordinator.safeRollbackStart(prefs, token.uid, token.sessionId, token.generation, token.lifecycleSeq)
        if (activeStartAuthorization == token) activeStartAuthorization = null
        // A failed reconstruction only owns its captured epoch. Reentrant worker
        // callbacks may already have installed a replacement owner or binding.
        val replacementTokens = listOfNotNull(
            getActiveToken(), activeStartAuthorization, activeTaskBinding?.token,
            provisionalForegroundToken, inFlightStartupToken, readPersistedOwnerToken(prefs)
        )
        if (replacementTokens.any { it != token }) return
        activeUid = null
        activeSessionId = null
        activeGeneration = null
        activeLifecycleSeq = null
        activeState = NativeOwnershipCoordinator.STATE_STOPPED
        isRunning = false

        if (!bypassAndroidSystemServicesForTesting) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
            } catch (_: Throwable) {}
            if (startId > 0) stopSelf(startId) else stopSelf()
        }
    }

    private fun readPersistedOwnerToken(prefs: SharedPreferences): SessionToken? = try {
        val raw = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
        if (raw == null) null else parseRestartToken(JSONObject(raw))
    } catch (_: Throwable) { null }

    private fun parseRestartToken(obj: JSONObject): SessionToken? {
        val uid = NativeOwnershipCoordinator.parseStrictString(obj.opt("uid")) ?: return null
        val sessionId = NativeOwnershipCoordinator.parseStrictString(obj.opt("sessionId")) ?: return null
        val generation = NativeOwnershipCoordinator.parseStrictInt(obj.opt("generation")) ?: return null
        val seq = NativeOwnershipCoordinator.parseStrictLong(obj.opt("lifecycleSeq")) ?: return null
        return SessionToken(uid, sessionId, generation, seq)
    }

    private fun readRestartCallbackHandle(prefs: SharedPreferences, payload: JSONObject): Long? {
        val payloadHandle = NativeOwnershipCoordinator.parseStrictCallbackHandle(payload.opt("callbackHandle"))
        if (payload.has("callbackHandle") && payloadHandle == null) return null
        return if (prefs.contains(NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE)) {
            val persistedHandle = NativeOwnershipCoordinator.parseStrictCallbackHandle(prefs.all[NativeOwnershipCoordinator.KEY_CALLBACK_HANDLE])
            if (payload.has("callbackHandle") && persistedHandle != payloadHandle) null else persistedHandle
        } else {
            payloadHandle
        }
    }

    private fun hasExactRestartAuthority(prefs: SharedPreferences, token: SessionToken, callbackHandle: Long): Boolean = try {
        val owner = JSONObject(prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null) ?: "")
        val payload = JSONObject(prefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null) ?: "")
        parseRestartToken(owner) == token &&
            NativeOwnershipCoordinator.parseStrictString(owner.opt("state")) == NativeOwnershipCoordinator.STATE_ACTIVE &&
            parseRestartToken(payload) == token &&
            NativeOwnershipCoordinator.getRestartReadinessGrant(prefs) == token &&
            prefs.getString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, null) == NativeOwnershipCoordinator.LIFECYCLE_PERMIT_RESTART &&
            NativeOwnershipCoordinator.parseStrictLong(prefs.all[NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE]) == token.lifecycleSeq &&
            readRestartCallbackHandle(prefs, payload) == callbackHandle
    } catch (_: Throwable) { false }

    private fun rejectUnauthorizedRestart(token: SessionToken?, startId: Int) {
        if (token != null) releaseLocks(token)
        isRunning = false
        activeState = NativeOwnershipCoordinator.STATE_STOPPED
        if (!bypassAndroidSystemServicesForTesting) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
            } catch (_: Throwable) {}
            if (startId > 0) stopSelf(startId) else stopSelf()
        }
    }

    private fun handleSystemRestart(startId: Int): Int {
        var tokenToRollback: SessionToken? = null
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            val prefs = getPrefs()
            val ownerJson = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
            if (ownerJson == null || ownerJson.trim().isEmpty()) {
                isRunning = false
                activeState = NativeOwnershipCoordinator.STATE_STOPPED
                if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                return START_NOT_STICKY
            }

            try {
                val ownerObj = JSONObject(ownerJson)
                val state = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("state"))
                if (state != NativeOwnershipCoordinator.STATE_ACTIVE) {
                    isRunning = false
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED
                    if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                    return START_NOT_STICKY
                }

                val restoredUid = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("uid"))
                val restoredSessionId = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("sessionId"))
                val restoredGen = NativeOwnershipCoordinator.parseStrictInt(ownerObj.opt("generation"))
                val restoredSeq = NativeOwnershipCoordinator.parseStrictLong(ownerObj.opt("lifecycleSeq"))
                val restoredStartedAt = NativeOwnershipCoordinator.parseStrictString(ownerObj.opt("startedAt"))

                if (restoredUid == null || restoredSessionId == null ||
                    restoredGen == null || restoredSeq == null ||
                    restoredStartedAt == null) {
                    cleanQuarantineMalformedOwner(prefs, ownerJson)
                    isRunning = false
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED
                    if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                    return START_NOT_STICKY
                }

                if (ownerObj.has("executionEpoch")) {
                    val epoch = NativeOwnershipCoordinator.parseStrictLong(ownerObj.opt("executionEpoch"))
                    if (epoch == null) {
                        cleanQuarantineMalformedOwner(prefs, ownerJson)
                        isRunning = false
                        activeState = NativeOwnershipCoordinator.STATE_STOPPED
                        if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                        return START_NOT_STICKY
                    }
                }

                val token = SessionToken(restoredUid, restoredSessionId, restoredGen, restoredSeq)
                tokenToRollback = token

                // Positive worker restart readiness and lifecycle validation
                val restartLifecycle = prefs.getString(NativeOwnershipCoordinator.KEY_RESTART_LIFECYCLE, null)
                if (restartLifecycle != NativeOwnershipCoordinator.LIFECYCLE_PERMIT_RESTART) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                val readinessGrant = NativeOwnershipCoordinator.getRestartReadinessGrant(prefs)
                if (readinessGrant != token) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                // Check contradictory worker payload
                val workerPayloadJson = prefs.getString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, null)
                if (workerPayloadJson == null || workerPayloadJson.trim().isEmpty()) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }
                val pObj = JSONObject(workerPayloadJson)
                val pUid = NativeOwnershipCoordinator.parseStrictString(pObj.opt("uid"))
                val pSessionId = NativeOwnershipCoordinator.parseStrictString(pObj.opt("sessionId"))
                val pGen = NativeOwnershipCoordinator.parseStrictInt(pObj.opt("generation"))
                val pSeq = NativeOwnershipCoordinator.parseStrictLong(pObj.opt("lifecycleSeq"))
                if (pUid != restoredUid || pSessionId != restoredSessionId ||
                    pGen != restoredGen || pSeq != restoredSeq) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                // Check contradictory monotonic sequence counter
                val monotonicSeq = NativeOwnershipCoordinator.parseStrictLong(prefs.all[NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE])
                if (monotonicSeq != restoredSeq) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                // 1. Read KEY_CALLBACK_HANDLE strictly from persistent storage
                val callbackHandle = readRestartCallbackHandle(prefs, pObj)

                if (callbackHandle != null) {
                    // Test injector
                    testRestartReconstructionFailureInjector?.let { injector ->
                        throw injector.invoke()
                    }

                    if (!hasExactRestartAuthority(prefs, token, callbackHandle)) {
                        failClosedRestart(prefs, token, startId)
                        return START_NOT_STICKY
                    }

                    // 2. Recreate foreground notification
                    if (!bypassAndroidSystemServicesForTesting) {
                        val notification = safeCreateNotification(null, null)
                        if (notification == null) {
                            failClosedRestart(prefs, token, startId)
                            return START_NOT_STICKY
                        }
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                            } else {
                                startForeground(NOTIFICATION_ID, notification)
                            }
                        } catch (_: Throwable) {
                            failClosedRestart(prefs, token, startId)
                            return START_NOT_STICKY
                        }
                    }

                    // 3. Reconstruct background worker
                    if (!bypassAndroidSystemServicesForTesting) {
                        activeStartAuthorization = token
                        try {
                            startBackgroundTask(callbackHandle, token)
                        } catch (t: Throwable) {
                            failClosedRestart(prefs, token, startId)
                            return START_NOT_STICKY
                        } finally {
                            if (activeStartAuthorization == token) {
                                activeStartAuthorization = null
                            }
                        }

                        // Verify task binding was created
                        val createdBinding = activeTaskBinding
                        if (createdBinding == null || createdBinding.task == null || createdBinding.flutterEngine == null ||
                            createdBinding.isDestroyed || createdBinding.isTeardownPending || createdBinding.token != token) {
                            failClosedRestart(prefs, token, startId)
                            return START_NOT_STICKY
                        }
                    } else {
                        testTaskCreationFailureInjector?.let { injector ->
                            throw injector.invoke()
                        }
                        val factory = testRestartBindingFactory
                        val binding = if (factory == null) ServiceTaskBinding(token) else factory.invoke(token)
                        if (binding == null || binding.token != token || binding.isDestroyed || binding.isTeardownPending ||
                            !hasExactRestartAuthority(prefs, token, callbackHandle)) {
                            failClosedRestart(prefs, token, startId)
                            return START_NOT_STICKY
                        }
                        taskBindings[token] = binding
                        activeTaskBinding = binding
                    }
                } else {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                if (!hasExactRestartAuthority(prefs, token, callbackHandle) ||
                    activeTaskBinding?.token != token || activeTaskBinding?.isDestroyed != false) {
                    failClosedRestart(prefs, token, startId)
                    return START_NOT_STICKY
                }

                // 4. Re-acquire wake lock and Wi-Fi lock under restored token
                acquireLocks(this@DutyForegroundService, token, allowWakeLock = true, allowWifiLock = true)

                // 5. Restore active state and commit
                activeUid = restoredUid
                activeSessionId = restoredSessionId
                activeGeneration = restoredGen
                activeLifecycleSeq = restoredSeq
                activeState = NativeOwnershipCoordinator.STATE_ACTIVE
                isRunning = true
            } catch (_: Throwable) {
                tokenToRollback?.let { token ->
                    failClosedRestart(prefs, token, startId)
                } ?: run {
                    cleanQuarantineMalformedOwner(prefs, ownerJson)
                    isRunning = false
                    activeState = NativeOwnershipCoordinator.STATE_STOPPED
                    if (!bypassAndroidSystemServicesForTesting) stopSelf(startId)
                }
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    private fun finishTeardownForBinding(
        binding: ServiceTaskBinding,
        token: SessionToken?,
        error: String?
    ) {
        if (error != null) {
            binding.notifyCompletion(false, error)
            return
        }

        var stopForegroundFailed: String? = null
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            val isAuthoritative = token == null || (
                activeSessionId == token.sessionId &&
                activeGeneration == token.generation &&
                activeLifecycleSeq == token.lifecycleSeq &&
                (token.uid.isEmpty() || activeUid == null || activeUid == token.uid)
            )

            if (isAuthoritative && !bypassAndroidSystemServicesForTesting) {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                } catch (e: Exception) {
                    stopForegroundFailed = e.message ?: "stopForeground failed"
                }
            }

            if (stopForegroundFailed == null) {
                binding.flutterEngine?.let { engine ->
                    try { NativeOwnershipCoordinator.unregisterEngine(engine.dartExecutor.binaryMessenger) } catch (_: Throwable) {}
                }
                if (token != null) {
                    taskBindings.remove(token)
                }
                if (isAuthoritative) {
                    if (activeTaskBinding === binding) {
                        activeTaskBinding = null
                    }
                    if (foregroundTask === binding.task) {
                        foregroundTask = null
                    }
                    releaseLocks(token)
                }
            }
        }

        if (stopForegroundFailed != null) {
            binding.notifyCompletion(false, stopForegroundFailed)
        } else {
            binding.notifyCompletion(true, null)
        }
    }

    fun executeEffectiveTeardown(
        token: SessionToken? = null,
        onComplete: ((success: Boolean, error: String?) -> Unit)? = null
    ) {
        val capturedBinding: ServiceTaskBinding?
        val capturedTask: DutyForegroundTask?
        val capturedToken: SessionToken?

        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            val currentBinding = activeTaskBinding
            val activeToken = currentBinding?.token ?: if (activeSessionId != null && activeLifecycleSeq != null) {
                SessionToken(activeUid ?: "", activeSessionId!!, activeGeneration ?: 0, activeLifecycleSeq!!)
            } else null

            if (token != null) {
                capturedToken = token
                val bindingForToken = taskBindings[token]
                if (bindingForToken != null) {
                    capturedBinding = bindingForToken
                    capturedTask = bindingForToken.task ?: (if (currentBinding === bindingForToken) foregroundTask else null)
                } else if (currentBinding != null && currentBinding.token == token) {
                    capturedBinding = currentBinding
                    capturedTask = currentBinding.task ?: foregroundTask
                } else {
                    capturedBinding = null
                    capturedTask = null
                }
            } else {
                capturedToken = activeToken
                capturedBinding = currentBinding
                capturedTask = currentBinding?.task ?: foregroundTask
            }

            // Case 1: Absent binding (e.g. Gate C absent S1 teardown when S2 is active)
            if (capturedBinding == null && capturedTask == null) {
                onComplete?.invoke(true, null)
                return
            }

            // Case 2: Duplicate STOP joining in-flight teardown
            if (capturedBinding != null && capturedBinding.isTeardownPending) {
                if (onComplete != null) {
                    capturedBinding.awaitCompletion(onComplete)
                }
                return
            }

            // Mark pending teardown
            capturedBinding?.markTeardownPending()
            if (capturedBinding != null && onComplete != null) {
                capturedBinding.awaitCompletion(onComplete)
            }
        }

        val doActualTeardown = { callback: (Boolean, String?) -> Unit ->
            val binding = capturedBinding
            val task = capturedTask

            if (task == null) {
                // No task to destroy
                var stopForegroundFailed: String? = null
                synchronized(NativeOwnershipCoordinator.ownershipLock) {
                    val isAuthoritative = capturedToken == null || (
                        activeSessionId == capturedToken.sessionId &&
                        activeGeneration == capturedToken.generation &&
                        activeLifecycleSeq == capturedToken.lifecycleSeq &&
                        (capturedToken.uid.isEmpty() || activeUid == null || activeUid == capturedToken.uid)
                    )
                    if (isAuthoritative && !bypassAndroidSystemServicesForTesting) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                                stopForeground(STOP_FOREGROUND_REMOVE)
                            } else {
                                @Suppress("DEPRECATION")
                                stopForeground(true)
                            }
                        } catch (e: Exception) {
                            stopForegroundFailed = e.message ?: "stopForeground failed"
                        }
                    }
                    if (stopForegroundFailed == null && isAuthoritative) {
                        if (activeTaskBinding === binding) activeTaskBinding = null
                        foregroundTask = null
                        releaseLocks(capturedToken)
                    }
                }
                if (stopForegroundFailed != null) {
                    binding?.onLifecycleDestroyed(false, stopForegroundFailed)
                    binding?.notifyCompletion(false, stopForegroundFailed)
                    callback(false, stopForegroundFailed)
                } else {
                    binding?.onLifecycleDestroyed(true, null)
                    binding?.notifyCompletion(true, null)
                    callback(true, null)
                }
            } else {
                try {
                    runOnMainThreadIfNeeded {
                        task.destroy(false)
                    }
                    if (binding == null || binding.flutterEngine == null) {
                        binding?.onLifecycleDestroyed(true, null)
                        if (binding != null) {
                            finishTeardownForBinding(binding, capturedToken, null)
                        } else {
                            callback(true, null)
                        }
                    }
                } catch (e: Exception) {
                    binding?.markTeardownFailed(e.message ?: "Task destruction error")
                    if (binding == null) {
                        callback(false, e.message ?: "Task destruction error")
                    }
                }
            }
        }

        val interceptor = teardownInterceptor
        if (interceptor != null && capturedToken != null) {
            interceptor.invoke(capturedToken) { success, error ->
                if (success) {
                    doActualTeardown { realSuccess, realError ->
                        if (capturedBinding == null) {
                            onComplete?.invoke(realSuccess, realError)
                        }
                    }
                } else {
                    capturedBinding?.markTeardownFailed(error ?: "Teardown intercepted failure")
                    if (capturedBinding == null) {
                        onComplete?.invoke(false, error ?: "Teardown intercepted failure")
                    }
                }
            }
        } else {
            doActualTeardown { success, error ->
                if (capturedBinding == null) {
                    onComplete?.invoke(success, error)
                }
            }
        }
    }

    private fun scheduleEngineTeardownCompletion(
        binding: ServiceTaskBinding,
        token: SessionToken?,
        engine: FlutterEngine?
    ) {
        fun finishIfDetached() {
            engine?.let {
                try { NativeOwnershipCoordinator.unregisterEngine(it.dartExecutor.binaryMessenger) } catch (_: Throwable) {}
            }
            binding.onLifecycleDestroyed(true, null)
            finishTeardownForBinding(binding, token, null)
        }

        try {
            val mainLooper = Looper.getMainLooper()
            if (mainLooper != null) {
                val handler = Handler(mainLooper)
                var attempts = 0
                val checkRunnable = object : Runnable {
                    override fun run() {
                        attempts++
                        if (!isFlutterEngineAttached(engine) || attempts >= 50) {
                            finishIfDetached()
                        } else {
                            handler.postDelayed(this, 20)
                        }
                    }
                }
                handler.post(checkRunnable)
                return
            }
        } catch (_: Throwable) {}

        finishIfDetached()
    }

    private fun startBackgroundTask(callbackHandle: Long, token: SessionToken) {
        testTaskCreationFailureInjector?.let { injector ->
            throw injector.invoke()
        }
        testPreEngineFailureInjector?.let { injector ->
            throw injector.invoke()
        }

        // STEP 1: Pre-engine FlutterLoader initialization & verification
        testLoaderInitFailureInjector?.let { injector ->
            throw injector.invoke()
        }
        val flutterLoader = FlutterInjector.instance().flutterLoader()
        if (!flutterLoader.initialized()) {
            flutterLoader.startInitialization(this)
        }
        flutterLoader.ensureInitializationComplete(this, null)

        val binding = ServiceTaskBinding(token)
        taskBindings[token] = binding

        var allocatedEngine: FlutterEngine? = null
        var constructedTask: DutyForegroundTask? = null

        try {
            // STEP 2: Direct FlutterEngine allocation
            val engine = FlutterEngine(this)
            // STEP 3: Immediately place engine under cleanup scope
            allocatedEngine = engine
            binding.flutterEngine = engine

            // Injection boundary for B6: Engine allocated -> fail before dependency init
            testEngineAllocatedBeforeDependencyInitInjector?.let { injector ->
                throw injector.invoke()
            }

            // STAGE 2: Immediately post-engine allocation
            testPostEngineAllocationInjector?.let { injector ->
                throw injector.invoke()
            }

            // STAGE 3: Post-plugin registration
            testPostPluginRegistrationInjector?.let { injector ->
                throw injector.invoke()
            }

            try {
                engine.addEngineLifecycleListener(object : FlutterEngine.EngineLifecycleListener {
                    override fun onPreEngineRestart() {}
                    override fun onEngineWillDestroy() {
                        scheduleEngineTeardownCompletion(binding, token, engine)
                    }
                })
            } catch (_: Throwable) {}

            NativeOwnershipCoordinator.registerWithEngine(this@DutyForegroundService, engine.dartExecutor.binaryMessenger, token)

            // STAGE 4: Post-engine-bound channel registration
            testPostEngineChannelRegistrationInjector?.let { injector ->
                throw injector.invoke()
            }

            testPostEngineFailureInjector?.let { injector ->
                throw injector.invoke()
            }

            // STAGE 5: Task constructor failure
            testTaskConstructorFailureInjector?.let { injector ->
                throw injector.invoke()
            }

            val serviceStatus = ForegroundServiceStatus(ForegroundServiceAction.API_START)
            val taskData = ForegroundTaskData(callbackHandle)
            val eventAction = ForegroundTaskEventAction(ForegroundTaskEventType.REPEAT, 5000L)
            val lifecycleListener = object : FlutterForegroundTaskLifecycleListener {
                override fun onEngineCreate(flutterEngine: FlutterEngine?) {}
                override fun onTaskStart(starter: FlutterForegroundTaskStarter) {}
                override fun onTaskRepeatEvent() {}
                override fun onTaskDestroy() {}
                override fun onEngineWillDestroy() {}
            }

            val task = DutyForegroundTask(this, engine, serviceStatus, taskData, eventAction, lifecycleListener)
            constructedTask = task

            // Two-phase initialization: registers background channel, resolves callback, executes Dart
            task.initialize()

            // STAGE 6: Post-task / pre-binding failure
            testPostTaskFailureInjector?.let { injector ->
                throw injector.invoke()
            }

            // STEP 4: Publish final binding only after complete success
            synchronized(NativeOwnershipCoordinator.ownershipLock) {
                if (activeStartAuthorization != token || readPersistedOwnerToken(getPrefs()) != token) {
                    throw IllegalStateException("Worker ownership changed before binding publication")
                }
                binding.task = task
                foregroundTask = task
                activeTaskBinding = binding
            }
        } catch (t: Throwable) {
            // Teardown partial engine and task to prevent leaks
            if (activeTaskBinding === binding) {
                activeTaskBinding = null
            }
            if (foregroundTask === constructedTask) {
                foregroundTask = null
            }
            taskBindings.remove(token)
            binding.flutterEngine = null
            binding.task = null
            try {
                constructedTask?.destroy(false)
            } catch (_: Throwable) {}
            allocatedEngine?.let { engine ->
                try {
                    NativeOwnershipCoordinator.unregisterEngine(engine.dartExecutor.binaryMessenger)
                } catch (_: Throwable) {}
                try {
                    engine.destroy()
                } catch (_: Throwable) {}
            }
            try {
                binding.onLifecycleDestroyed(false, t.message ?: "Construction failed")
            } catch (_: Throwable) {}
            if (t is Exception) throw t
            else throw RuntimeException(t)
        }
    }

    private fun createNotification(title: String?, text: String?): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Duty Location Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active driver duty location tracking service"
                enableVibration(false)
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }

        val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(title ?: "On Duty")
            .setContentText(text ?: "Location sharing is active")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        return builder.build()
    }

    override fun onDestroy() {
        super.onDestroy()
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            releaseLocks(null)
            executeEffectiveTeardown()
            isRunning = false
            activeState = NativeOwnershipCoordinator.STATE_STOPPED
            activeTaskBinding = null
            activeUid = null
            activeSessionId = null
            activeGeneration = null
            activeLifecycleSeq = null
            instance = null
        }
    }
}
