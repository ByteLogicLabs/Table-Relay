package com.brainfactory.db.update

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.brainfactory.db.ui.bd
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Where buyers write for help, shown on the sign-in screen. */
const val SUPPORT_EMAIL = "brainfactory@syntac.co"

/**
 * Brain DB is for its buyers: until the user signs in with a code sent to the email they bought it with, the whole
 * window is the sign-in screen (Brain Code's AuthGateScreen, in Brain DB's colours) and [content] doesn't show.
 */
@Composable
fun LicenceGate(content: @Composable () -> Unit) {
    val updater = Updater.get(LocalContext.current)
    if (updater.licence != null) content() else SignInScreen(updater)
}

/**
 * The sign-in in front of everything else: Brain DB is licensed to a Brain Factory account, proven with a 6-digit
 * code sent to its email. Once signed in, the app works offline until the licence ends (30 days), then asks again.
 */
@Composable
private fun SignInScreen(updater: Updater) {
    val t = bd
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf(updater.lastEmail) }
    var code by rememberSaveable { mutableStateOf("") }
    var codeSent by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    /** Seconds until another code may be asked for. */
    var cooldown by remember { mutableIntStateOf(0) }
    LaunchedEffect(cooldown) { if (cooldown > 0) { delay(1000); cooldown-- } }

    fun sendCode() {
        val address = email.trim()
        if (busy) return
        if (!EMAIL.matches(address)) { error = "Enter a valid email address."; return }
        busy = true
        error = null
        scope.launch {
            updater.requestCode(address)
                .onSuccess { message ->
                    email = address
                    codeSent = true
                    code = ""
                    cooldown = RESEND_SECONDS
                    info = message.ifBlank { "We sent a 6-digit code to $address." }
                }
                .onFailure { error = it.message ?: "Could not reach app.brainfactory.id." }
            busy = false
        }
    }

    fun verify() {
        if (busy || code.length != CODE_LENGTH) return
        busy = true
        error = null
        scope.launch {
            updater.verifyCode(email, code).onFailure {
                error = it.message ?: "Could not reach app.brainfactory.id."
                code = ""
            }
            busy = false
        }
    }

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(t.background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        val screenHeight = maxHeight
        Column(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = screenHeight)
                .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val logo = remember { context.getDrawable(context.applicationInfo.icon)?.toBitmap(192, 192)?.asImageBitmap() }
                if (logo != null) {
                    Image(logo, contentDescription = "Brain DB", modifier = Modifier.size(48.dp))
                    Spacer(Modifier.width(12.dp))
                }
                Column {
                    Text("Brain DB", color = t.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    Text(if (codeSent) "Enter the code" else "Sign in", color = t.textDim, fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(24.dp))

            if (!codeSent) {
                GateText("Sign in with the email of your Brain Factory account. We will send you a 6-digit code; no password needed.")
                GateField("Email", email, KeyboardType.Email, ImeAction.Send, onAction = ::sendCode) { email = it; error = null }
                Spacer(Modifier.height(16.dp))
                GateButton(if (busy) "Sending…" else "Send Code", enabled = !busy && email.isNotBlank(), onClick = ::sendCode)
            } else {
                info?.let { GateText(it) }
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                Text("Code", color = t.textDim, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp))
                BasicTextField(
                    value = code,
                    onValueChange = { v ->
                        code = v.filter(Char::isDigit).take(CODE_LENGTH)
                        error = null
                        // The last digit signs in, as code fields do
                        if (code.length == CODE_LENGTH) verify()
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { verify() }),
                    textStyle = TextStyle(color = t.text, fontSize = 24.sp, fontFamily = FontFamily.Monospace, letterSpacing = 10.sp),
                    cursorBrush = SolidColor(t.text),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .background(t.field, RoundedCornerShape(4.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
                Spacer(Modifier.height(16.dp))
                GateButton(if (busy) "Verifying…" else "Sign In", enabled = !busy && code.length == CODE_LENGTH, onClick = ::verify)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.weight(1f)) {
                        GateButton(if (cooldown > 0) "Resend in ${cooldown}s" else "Resend Code", enabled = !busy && cooldown == 0, primary = false, onClick = ::sendCode)
                    }
                    Box(Modifier.weight(1f)) {
                        GateButton("Change Email", enabled = !busy, primary = false) { codeSent = false; code = ""; error = null; info = null }
                    }
                }
            }
            error?.let { Text(it, color = t.danger, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp)) }
            Spacer(Modifier.height(24.dp))
            Text("Need help? $SUPPORT_EMAIL", color = t.textDim, fontSize = 12.sp)
        }
    }
}

@Composable
private fun GateText(text: String) {
    Text(text, color = bd.text, fontSize = 14.sp, lineHeight = 20.sp, modifier = Modifier.padding(bottom = 14.dp))
}

@Composable
private fun GateField(label: String, value: String, type: KeyboardType, ime: ImeAction, onAction: () -> Unit, onChange: (String) -> Unit) {
    val t = bd
    Text(label, color = t.textDim, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp))
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ime),
        keyboardActions = KeyboardActions(onSend = { onAction() }, onDone = { onAction() }),
        textStyle = TextStyle(color = t.text, fontSize = 15.sp),
        cursorBrush = SolidColor(t.text),
        modifier = Modifier
            .fillMaxWidth()
            .background(t.field, RoundedCornerShape(4.dp))
            .padding(horizontal = 10.dp, vertical = 11.dp),
    )
}

@Composable
private fun GateButton(label: String, enabled: Boolean, primary: Boolean = true, onClick: () -> Unit) {
    val t = bd
    val shape = RoundedCornerShape(4.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .then(if (primary) Modifier.background(if (enabled) t.accent else t.accent.copy(alpha = 0.45f), shape) else Modifier.border(1.dp, t.field, shape))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (primary) t.onAccent else if (enabled) t.text else t.textDim, fontSize = 14.sp, fontWeight = if (primary) FontWeight.Medium else FontWeight.Normal)
    }
}

private const val CODE_LENGTH = 6
private const val RESEND_SECONDS = 60
private val EMAIL = Regex("[^@\\s]+@[^@\\s]+\\.[^@\\s]+")
