plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

// Local servers: PostgreSQL, MariaDB, Redis and Valkey run on the phone itself. Nothing is bundled: the servers are
// Termux's Android builds, downloaded when asked for (the repository's signed index checked against Termux's key,
// each package against its SHA-256), unpacked into the app's files and run from there. Android doesn't let an app
// exec files it wrote (W^X from targetSdk 29), so they run through the system linker, and the small exec shim in
// src/main/cpp does the same for the programs they start themselves (initdb starting postgres).
android {
    namespace = "com.brainfactory.db.host"
    compileSdk = 35
    ndkVersion = "27.3.13750724"

    defaultConfig {
        minSdk = 26
        // The suites in src/androidTest download each server and run it on a device (see their docs).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // The test APK targets the same SDK as the app, so it runs under the same rules (no exec of app files on 29+).
    testOptions {
        targetSdk = 35
    }
    packaging {
        // The shim is preloaded by path, so it has to be a file in nativeLibraryDir, not left inside the APK.
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf("META-INF/versions/*/OSGI-INF/MANIFEST.MF", "META-INF/versions/*/module-info.class", "module-info.class", "META-INF/native-image/**", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

dependencies {
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.xz)
    implementation(libs.bouncycastle)
    implementation(libs.bouncycastle.pg)
    implementation(libs.bouncycastle.util)
    testImplementation(libs.junit)
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.junit)
    // The suites check each server with Brain DB's own drivers.
    androidTestImplementation(project(":engine"))
}
