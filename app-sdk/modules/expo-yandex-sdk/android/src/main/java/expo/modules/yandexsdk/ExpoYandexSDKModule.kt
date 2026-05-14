package expo.modules.yandexsdk

import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import com.yandex.authsdk.YandexAuthLoginOptions
import com.yandex.authsdk.YandexAuthOptions
import com.yandex.authsdk.YandexAuthResult
import com.yandex.authsdk.YandexAuthSdk
import com.yandex.authsdk.internal.strategy.LoginType
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class YandexAuthException(message: String) : CodedException("YANDEX_AUTH_ERROR", message, null)

class ExpoYandexSDKModule : Module() {
    private var pendingPromise: Promise? = null
    private var launcher: ActivityResultLauncher<YandexAuthLoginOptions>? = null
    private var sdk: YandexAuthSdk? = null

    private fun resolvePending(result: Map<String, Any>) {
        val promise = pendingPromise ?: return
        pendingPromise = null
        promise.resolve(result)
    }

    private fun rejectPending(message: String) {
        val promise = pendingPromise ?: return
        pendingPromise = null
        promise.reject(YandexAuthException(message))
    }

    private fun ensureLauncher(activity: ComponentActivity) {
        if (launcher != null) return

        // SDK reads clientId from <meta-data android:name="com.yandex.auth.CLIENT_ID"> in the merged manifest.
        val options = YandexAuthOptions(activity.applicationContext, false)
        val newSdk = YandexAuthSdk.create(options)
        sdk = newSdk

        launcher = activity.activityResultRegistry.register(
            "expo-yandex-sdk-auth",
            newSdk.contract
        ) { result ->
            when (result) {
                is YandexAuthResult.Success -> {
                    val token = result.token
                    val activeSdk = sdk
                    // getJwt() makes a blocking network call to login.yandex.ru/info?format=jwt
                    // — it must NOT run on this result callback (the main thread). Off-thread it.
                    Thread {
                        if (activeSdk == null) {
                            rejectPending("Yandex SDK not initialised — cannot fetch JWT")
                        } else {
                            try {
                                val jwt = activeSdk.getJwt(token)
                                resolvePending(
                                    mapOf(
                                        "accessToken" to token.value,
                                        "expiresIn" to token.expiresIn,
                                        "jwt" to jwt
                                    )
                                )
                            } catch (e: Exception) {
                                rejectPending("getJwt failed: ${e.message}")
                            }
                        }
                    }.start()
                }
                is YandexAuthResult.Cancelled -> {
                    resolvePending(mapOf("cancelled" to true))
                }
                is YandexAuthResult.Failure -> {
                    rejectPending(result.exception.message ?: "Unknown Yandex auth error")
                }
            }
        }
    }

    override fun definition() = ModuleDefinition {
        Name("ExpoYandexSDK")

        AsyncFunction("authorize") { promise: Promise ->
            val activity = appContext.currentActivity as? ComponentActivity
            if (activity == null) {
                promise.reject(YandexAuthException("No current activity (or not a ComponentActivity)"))
                return@AsyncFunction
            }

            if (pendingPromise != null) {
                promise.reject(YandexAuthException("Authorization already in progress"))
                return@AsyncFunction
            }

            try {
                ensureLauncher(activity)
            } catch (e: Exception) {
                promise.reject(YandexAuthException(e.message ?: "Failed to initialise Yandex SDK"))
                return@AsyncFunction
            }

            pendingPromise = promise
            try {
                // LoginStrategyResolver auto-falls-back to Chrome Tab if no Yandex app is installed.
                launcher!!.launch(YandexAuthLoginOptions(LoginType.NATIVE))
            } catch (e: Exception) {
                pendingPromise = null
                promise.reject(YandexAuthException(e.message ?: "Failed to launch Yandex auth"))
            }
        }
    }
}
