package com.poc_01

import android.os.Bundle
import android.os.Build
import android.util.Log
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.oney.WebRTCModule.WebRTCModuleOptions

class MainActivity : ReactActivity() {
    companion object {
        private const val TAG = "MainActivity"
    }

    /**
     * Returns the name of the main component registered from JavaScript.
     */
    override fun getMainComponentName(): String = "POC_01"

    /**
     * Returns the instance of the [ReactActivityDelegate].
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        // Configure WebRTC Module Options BEFORE super.onCreate()
        val options = WebRTCModuleOptions.getInstance()
        
        // Enable Media Projection Service - Required for screen capture on Android 10+
        options.enableMediaProjectionService = true
        
        Log.d(TAG, "WebRTC Options configured:")
        Log.d(TAG, "- enableMediaProjectionService: true")
        Log.d(TAG, "- Android SDK: ${Build.VERSION.SDK_INT}")
        Log.d(TAG, "- Android Version: ${Build.VERSION.RELEASE}")
        
        // For Android 10+ (API 29+), system audio capture is supported
        // but requires user to select "Record audio" in the media projection dialog
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Log.d(TAG, "Android 10+ detected - System audio capture is supported")
            Log.d(TAG, "Note: User must select 'Record audio' or 'Device audio' in screen share dialog")
        }
        
        // For Android 14+ (API 34+), additional considerations
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Log.d(TAG, "Android 14+ detected - Using PROPERTY_SPECIAL_USE_FGS_SUBTYPE")
        }
        
        super.onCreate(savedInstanceState)
    }
}