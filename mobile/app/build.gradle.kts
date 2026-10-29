plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Version from gradle.properties; a release build may pass its version (-PappVersion=1.2.3).
val appVersion = (findProperty("appVersion") as String).removePrefix("v")
val appVersionCode = (appVersion.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)).take(3)
    .let { (major, minor, patch) -> major * 1_000_000 + minor * 1_000 + patch }

android {
    namespace = "com.brainfactory.db"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.brainfactory.db"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        // A test update server (-PupdateUrl=http://10.0.2.2:…) is plain HTTP; released builds only talk HTTPS to it.
        // Databases are another matter: a server on the LAN often has no TLS, so cleartext stays allowed for them.
    }

    // An update only installs over a copy signed with the same key, so releases are signed with one fixed key
    // (alias "upload"). It lives outside the repo: local builds point BRAIN_KEYSTORE at it.
    signingConfigs {
        create("release") {
            val keystore = System.getenv("BRAIN_KEYSTORE")
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("BRAIN_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("BRAIN_KEY_ALIAS") ?: "upload"
                keyPassword = System.getenv("BRAIN_KEY_PASSWORD") ?: System.getenv("BRAIN_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // The JDBC and MongoDB drivers find their parts by reflection and ServiceLoader, so the code isn't shrunk.
            isMinifyEnabled = false
            // Without the release key (a build of a fork, say) the APK is signed with the debug key so it still
            // installs, but it can't update, or be updated by, a released copy.
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null } ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        // The local servers' shim (host/src/main/cpp) is preloaded by path, so native libraries are extracted.
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf(
            "META-INF/versions/*/OSGI-INF/MANIFEST.MF", "META-INF/versions/*/module-info.class", "module-info.class", "META-INF/native-image/**",
            "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/DEPENDENCIES", "META-INF/INDEX.LIST",
        )
    }
}

dependencies {
    implementation(project(":core-ui"))
    implementation(project(":engine"))
    implementation(project(":updater"))
    implementation(project(":host"))

    implementation(libs.androidsvg)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
