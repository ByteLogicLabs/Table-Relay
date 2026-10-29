package com.brainfactory.db.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val SmallRadius = RoundedCornerShape(6.dp)
val CardRadius = RoundedCornerShape(10.dp)

/** A filled (primary) or outlined button. */
@Composable
fun BdButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    enabled: Boolean = true,
    danger: Boolean = false,
    icon: ImageVector? = null,
) {
    val t = bd
    val content: @Composable RowScope.() -> Unit = {
        if (icon != null) {
            Icon(icon, null, Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(label, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    val padding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
    if (primary || danger) {
        Button(
            onClick, modifier.heightIn(min = 38.dp), enabled = enabled, shape = SmallRadius, contentPadding = padding,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (danger) t.danger else t.accent,
                contentColor = if (danger) Color.White else t.onAccent,
                disabledContainerColor = (if (danger) t.danger else t.accent).copy(alpha = 0.4f),
                disabledContentColor = (if (danger) Color.White else t.onAccent).copy(alpha = 0.7f),
            ),
            content = content,
        )
    } else {
        OutlinedButton(
            onClick, modifier.heightIn(min = 38.dp), enabled = enabled, shape = SmallRadius, contentPadding = padding,
            border = androidx.compose.foundation.BorderStroke(1.dp, t.fieldBorder),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = t.text, disabledContentColor = t.textFaint),
            content = content,
        )
    }
}

/** A labelled single- or multi-line text field in the app's field style. */
@Composable
fun BdTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    singleLine: Boolean = true,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    onAction: (() -> Unit)? = null,
    mono: Boolean = false,
    minLines: Int = 1,
    enabled: Boolean = true,
    help: String? = null,
) {
    val t = bd
    var focused by remember { mutableStateOf(false) }
    var reveal by remember { mutableStateOf(false) }
    Column(modifier) {
        if (label != null) BdLabel(label)
        Row(
            Modifier
                .fillMaxWidth()
                .clip(SmallRadius)
                .background(t.field)
                .border(1.dp, if (focused) t.accent else t.fieldBorder, SmallRadius),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 10.dp)) {
                if (value.isEmpty() && placeholder != null) {
                    Text(placeholder, color = t.textFaint, style = if (mono) monoStyle(14) else TextStyle(fontSize = 15.sp), maxLines = if (singleLine) 1 else minLines)
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    singleLine = singleLine,
                    minLines = if (singleLine) 1 else minLines,
                    visualTransformation = if (password && !reveal) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (password) KeyboardType.Password else keyboardType,
                        imeAction = if (singleLine) imeAction else ImeAction.Default,
                        autoCorrectEnabled = false,
                    ),
                    keyboardActions = KeyboardActions(onDone = { onAction?.invoke() }, onGo = { onAction?.invoke() }, onSend = { onAction?.invoke() }, onSearch = { onAction?.invoke() }),
                    textStyle = (if (mono) monoStyle(14) else TextStyle(fontSize = 15.sp)).copy(color = if (enabled) t.text else t.textDim),
                    cursorBrush = SolidColor(t.accent),
                    modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
                )
            }
            if (password) {
                IconButton(onClick = { reveal = !reveal }, modifier = Modifier.size(40.dp)) {
                    Icon(if (reveal) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, if (reveal) "Hide" else "Show", tint = t.textDim, modifier = Modifier.size(18.dp))
                }
            }
        }
        if (help != null) Text(help, color = t.textFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
    }
}

@Composable
fun BdLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, color = bd.textDim, fontSize = 12.sp, modifier = modifier.padding(bottom = 4.dp))
}

/** A small caps heading over a group of rows. */
@Composable
fun BdSectionHeader(text: String, modifier: Modifier = Modifier, trailing: String? = null) {
    val t = bd
    Row(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), color = t.textFaint, fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, color = t.textFaint, fontSize = 11.sp)
    }
}

@Composable
fun BdDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, thickness = 1.dp, color = bd.border)
}

/** A one-choice dropdown that shows [selected]'s label. */
@Composable
fun <T> BdSelect(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
    title: String? = null,
    enabled: Boolean = true,
) {
    val t = bd
    var open by remember { mutableStateOf(false) }
    Column(modifier) {
        if (title != null) BdLabel(title)
        Box {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(SmallRadius)
                    .background(t.field)
                    .border(1.dp, t.fieldBorder, SmallRadius)
                    .clickable(enabled = enabled) { open = true }
                    .padding(start = 10.dp, end = 4.dp, top = 9.dp, bottom = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label(selected), color = if (enabled) t.text else t.textDim, fontSize = 15.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Filled.ArrowDropDown, null, tint = t.textDim)
            }
            DropdownMenu(open, { open = false }) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(label(option), color = if (option == selected) t.accent else t.text) },
                        onClick = { open = false; onSelect(option) },
                    )
                }
            }
        }
    }
}

/** A row with a label, an optional description and a switch. */
@Composable
fun BdSwitchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, description: String? = null, inset: Dp = 16.dp) {
    val t = bd
    Row(
        modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(horizontal = inset, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = t.text, fontSize = 15.sp)
            if (description != null) Text(description, color = t.textDim, fontSize = 12.sp)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked, onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = t.accent, checkedThumbColor = t.onAccent, uncheckedTrackColor = t.field, uncheckedBorderColor = t.fieldBorder),
        )
    }
}

/** A row that opens something: a title, an optional value or description, tappable. */
@Composable
fun BdListRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    trailing: @Composable (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val t = bd
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = iconTint ?: t.textDim, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, color = t.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, color = t.textDim, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke()
    }
}

/** A small rounded tag, e.g. the SSH badge on a tunnelled connection. */
@Composable
fun BdBadge(text: String, color: Color = bd.accent, modifier: Modifier = Modifier) {
    Text(
        text,
        color = color,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/** Choices side by side, one selected, like the desktop's Schema | Data toggle. */
@Composable
fun <T> BdSegmented(options: List<T>, selected: T, onSelect: (T) -> Unit, label: (T) -> String, modifier: Modifier = Modifier) {
    val t = bd
    Row(
        modifier.clip(SmallRadius).background(t.field).border(1.dp, t.border, SmallRadius).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { option ->
            val on = option == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(5.dp))
                    .background(if (on) t.panel else Color.Transparent)
                    .clickable { onSelect(option) }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label(option), color = if (on) t.text else t.textDim, fontSize = 13.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal)
            }
        }
    }
}

/** A dialog with a title, a body and up to two buttons, in the app's colours. */
@Composable
fun BdDialog(
    title: String,
    onDismiss: () -> Unit,
    confirmLabel: String? = "OK",
    onConfirm: (() -> Unit)? = null,
    dismissLabel: String? = "Cancel",
    confirmEnabled: Boolean = true,
    danger: Boolean = false,
    width: Dp? = null,
    content: @Composable () -> Unit,
) {
    val t = bd
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = if (width != null) Modifier.width(width) else Modifier,
        containerColor = t.panel,
        titleContentColor = t.text,
        textContentColor = t.text,
        shape = CardRadius,
        title = { Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold) },
        text = { content() },
        confirmButton = {
            if (confirmLabel != null && onConfirm != null) {
                TextButton(onConfirm, enabled = confirmEnabled) { Text(confirmLabel, color = if (!confirmEnabled) t.textFaint else if (danger) t.danger else t.accent, fontWeight = FontWeight.SemiBold) }
            }
        },
        dismissButton = {
            if (dismissLabel != null) TextButton(onDismiss) { Text(dismissLabel, color = t.textDim) }
        },
    )
}

/** An empty-state message in the middle of a pane. */
@Composable
fun BdEmpty(title: String, modifier: Modifier = Modifier, message: String? = null, icon: ImageVector? = null, action: @Composable (() -> Unit)? = null) {
    val t = bd
    Column(modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        if (icon != null) {
            Icon(icon, null, tint = t.textFaint, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(10.dp))
        }
        Text(title, color = t.text, fontSize = 16.sp, fontWeight = FontWeight.Medium)
        if (message != null) {
            Spacer(Modifier.height(4.dp))
            Text(message, color = t.textDim, fontSize = 13.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        if (action != null) {
            Spacer(Modifier.height(14.dp))
            action()
        }
    }
}
