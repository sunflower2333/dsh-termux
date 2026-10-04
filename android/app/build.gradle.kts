plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.sunflower2333.dsh"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.sunflower2333.dsh"
        // DSH's Android target is Android 11 and newer. The bundled Node
        // runtime and WebView integration are tested against API 30+.
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        jniLibs.useLegacyPackaging = true
    }
androidResources { noCompress += "zip" }
}

// Runtime assets are produced by the Android runtime packaging step.  Never
// create an empty placeholder: an APK without DSH is unusable.
tasks.register("verifyRuntimeAssets") {
    val manifest = file("src/main/assets/runtime/manifest.json")
    val runtimeZip = file("src/main/assets/runtime/runtime.zip")
    val node = file("src/main/jniLibs/arm64-v8a/libdsh_node.so")
    val cxx = file("src/main/jniLibs/arm64-v8a/libc++_shared.so")
    doLast {
        check(manifest.isFile) {
            "Missing ${manifest.relativeTo(projectDir)}; generate the real DSH runtime first"
        }
        check(runtimeZip.isFile) {
            "Missing ${runtimeZip.relativeTo(projectDir)}; generate the real DSH runtime first"
        }
        check(node.isFile && node.canRead()) {
            "Missing ${node.relativeTo(projectDir)}; build the arm64 Node runtime first"
        }
        check(cxx.isFile && cxx.canRead()) {
            "Missing ${cxx.relativeTo(projectDir)}; copy the NDK libc++_shared.so first"
        }
    }
}

tasks.configureEach {
    if (name.startsWith("pre") && name.endsWith("Build")) dependsOn("verifyRuntimeAssets")
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
