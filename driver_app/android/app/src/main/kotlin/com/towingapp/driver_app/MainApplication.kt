package com.towingapp.driver_app

import com.pravera.flutter_foreground_task.FlutterForegroundTaskLifecycleListener
import com.pravera.flutter_foreground_task.FlutterForegroundTaskPlugin
import com.pravera.flutter_foreground_task.FlutterForegroundTaskStarter
import io.flutter.app.FlutterApplication
import io.flutter.embedding.engine.FlutterEngine

class MainApplication : FlutterApplication() {
    override fun onCreate() {
        super.onCreate()
        NativeOwnershipCoordinator.init(this)

        FlutterForegroundTaskPlugin.addTaskLifecycleListener(object : FlutterForegroundTaskLifecycleListener {
            override fun onEngineCreate(flutterEngine: FlutterEngine?) {
                flutterEngine?.let {
                    NativeOwnershipCoordinator.registerWith(this@MainApplication, it.dartExecutor.binaryMessenger)
                }
            }

            override fun onTaskStart(starter: FlutterForegroundTaskStarter) {}
            override fun onTaskRepeatEvent() {}
            override fun onTaskDestroy() {}
            override fun onEngineWillDestroy() {}
        })
    }
}
