package com.brainfactory.db.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

/**
 * Brain DB's colours, taken from Table Relay (desktop/src/index.css and its dark workbench): zinc greys for the
 * chrome, the amber accent of its selection and update buttons, and the usual red and green for errors and success.
 */
@Immutable
data class BdColors(
    val dark: Boolean,
    /** Behind everything: the grid and the editor. */
    val background: Color,
    /** Side panels, cards and sheets. */
    val panel: Color,
    /** Top bars, tab strips and the bottom bar. */
    val chrome: Color,
    val field: Color,
    val fieldBorder: Color,
    val border: Color,
    val text: Color,
    val textDim: Color,
    val textFaint: Color,
    val accent: Color,
    val onAccent: Color,
    /** The accent behind a selected row or object. */
    val selection: Color,
    val danger: Color,
    val success: Color,
    val warning: Color,
    /** Syntax colours for the query editor. */
    val keyword: Color,
    val string: Color,
    val number: Color,
    val comment: Color,
    /** How NULL looks in the grid. */
    val nullText: Color,
)

val DarkColors = BdColors(
    dark = true,
    background = Color(0xFF18181B),
    panel = Color(0xFF1F1F23),
    chrome = Color(0xFF141416),
    field = Color(0xFF27272A),
    fieldBorder = Color(0xFF3F3F46),
    border = Color(0xFF2C2C31),
    text = Color(0xFFFAFAFA),
    textDim = Color(0xFFA1A1AA),
    textFaint = Color(0xFF71717A),
    accent = Color(0xFFF2A33A),
    onAccent = Color(0xFF1B1206),
    selection = Color(0xFF4A3218),
    danger = Color(0xFFF87171),
    success = Color(0xFF4ADE80),
    warning = Color(0xFFFBBF24),
    keyword = Color(0xFFC586C0),
    string = Color(0xFFCE9178),
    number = Color(0xFFB5CEA8),
    comment = Color(0xFF6A9955),
    nullText = Color(0xFF71717A),
)

val LightColors = BdColors(
    dark = false,
    background = Color(0xFFFFFFFF),
    panel = Color(0xFFF5F5F7),
    chrome = Color(0xFFEDEDF0),
    field = Color(0xFFF1F1F3),
    fieldBorder = Color(0xFFD4D4D8),
    border = Color(0xFFE4E4E7),
    text = Color(0xFF09090B),
    textDim = Color(0xFF52525B),
    textFaint = Color(0xFF8A8A93),
    accent = Color(0xFFD9822B),
    onAccent = Color(0xFFFFFFFF),
    selection = Color(0xFFFCE7CF),
    danger = Color(0xFFDC2626),
    success = Color(0xFF16A34A),
    warning = Color(0xFFB45309),
    keyword = Color(0xFFAF00DB),
    string = Color(0xFFA31515),
    number = Color(0xFF098658),
    comment = Color(0xFF008000),
    nullText = Color(0xFFA1A1AA),
)

/** System, light or dark, as Settings › Appearance picks it. */
enum class ThemeMode { SYSTEM, LIGHT, DARK }

val LocalBdColors = staticCompositionLocalOf { DarkColors }

/** The current theme's colours. */
val bd: BdColors
    @Composable @ReadOnlyComposable get() = LocalBdColors.current

/** The grid's and the editor's font. */
val MonoFamily = FontFamily.Monospace

@Composable
fun BrainDbTheme(mode: ThemeMode = ThemeMode.SYSTEM, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val c = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.selection, onPrimaryContainer = c.text,
            secondary = c.accent, onSecondary = c.onAccent, secondaryContainer = c.field, onSecondaryContainer = c.text,
            background = c.background, onBackground = c.text, surface = c.panel, onSurface = c.text,
            surfaceVariant = c.field, onSurfaceVariant = c.textDim, surfaceContainer = c.panel,
            surfaceContainerHigh = c.field, surfaceContainerHighest = c.field, surfaceContainerLow = c.panel,
            surfaceContainerLowest = c.background, outline = c.fieldBorder, outlineVariant = c.border,
            error = c.danger, onError = Color.Black,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.selection, onPrimaryContainer = c.text,
            secondary = c.accent, onSecondary = c.onAccent, secondaryContainer = c.chrome, onSecondaryContainer = c.text,
            background = c.background, onBackground = c.text, surface = c.background, onSurface = c.text,
            surfaceVariant = c.panel, onSurfaceVariant = c.textDim, surfaceContainer = c.panel,
            surfaceContainerHigh = c.chrome, surfaceContainerHighest = c.chrome, surfaceContainerLow = c.panel,
            surfaceContainerLowest = c.background, outline = c.fieldBorder, outlineVariant = c.border,
            error = c.danger, onError = Color.White,
        )
    }
    val base = Typography()
    val typography = base.copy(
        bodyMedium = base.bodyMedium.copy(fontSize = 14.sp),
        bodySmall = base.bodySmall.copy(fontSize = 12.sp),
        labelSmall = base.labelSmall.copy(fontSize = 11.sp),
    )
    CompositionLocalProvider(LocalBdColors provides c) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}

/** Monospaced text for cells, statements and values. */
fun monoStyle(size: Int = 13, color: Color = Color.Unspecified) = TextStyle(fontFamily = MonoFamily, fontSize = size.sp, color = color)
