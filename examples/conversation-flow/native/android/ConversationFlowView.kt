package example.conversationflow

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject

// Host Activity supplies its normal lifecycle, window insets/IME policy and AndroidX WebKit dependency.
// Copy dist/standalone.html to src/main/assets/conversation-flow/standalone.html.
class ConversationFlowView(context: Context) : WebView(context) {
    private val page = "https://appassets.androidplatform.net/assets/conversation-flow/standalone.html"
    init {
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.toString().substringBefore('?') != page
        }
        addJavascriptInterface(Bridge(), "HemiNative")
        loadUrl("$page?native=1")
    }
    private inner class Bridge {
        @JavascriptInterface fun postMessage(json: String) {
            val request = try { JSONObject(json) } catch (_: Exception) { return }
            post {
                if (url?.substringBefore('?') != page || request.optInt("version") != 1) return@post
                val method = request.optString("method")
                if (method == "cancel" || method == "resources.release") return@post
                val payload = request.optJSONObject("payload") ?: JSONObject()
                val result = try {
                    when (method) {
                        "copyText" -> { val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("conversation", payload.getString("text")))
                            JSONObject().put("ok", true).put("value", JSONObject.NULL) }
                        "openLink" -> { val target = Uri.parse(payload.getString("url"))
                            require(target.scheme in listOf("https", "http"))
                            context.startActivity(Intent(Intent.ACTION_VIEW, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            JSONObject().put("ok", true).put("value", JSONObject.NULL) }
                        else -> JSONObject().put("ok", false).put("error", JSONObject().put("code", "unsupported").put("message", "当前原生示例未提供此能力"))
                    }
                } catch (_: Exception) { JSONObject().put("ok", false).put("error", JSONObject().put("code", "failed").put("message", "系统操作没有完成")) }
                val response = JSONObject().put("version", 1).put("scope", request.getJSONObject("scope")).put("requestId", request.getString("requestId")).put("result", result)
                evaluateJavascript("window.hemiNativeReceive?.($response)", null)
            }
        }
    }
    override fun destroy() { removeJavascriptInterface("HemiNative"); stopLoading(); super.destroy() }
}
